import type { TextChannel, AnyThreadChannel } from 'discord.js';

type SessionChannel = TextChannel | AnyThreadChannel;
import * as sessions from './thread-manager.ts';
import { handleOutputStream } from './output-handler.ts';
import {
  handleResultEvent,
  handleAwaitingHuman,
  queueDigest,
  updateSessionState,
} from './panel-adapter.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import { isAbortError, truncate } from './utils.ts';
import { config } from './config.ts';
import type {
  ThreadSession as Session,
  SessionMonitorFeedbackReport,
  SessionNextProofContract,
  SessionWorkerProgressReport,
} from './types.ts';
import type { ProviderEvent, ContentBlock, ProviderCanUseTool } from './providers/types.ts';

const MAX_MONITOR_ITERATIONS = 6;
const WORKER_IDLE_TIMEOUT_MS = 180_000; // 3 minutes - increased from 45s to handle slow API calls and large codebases

interface MonitorDecision extends SessionMonitorFeedbackReport {
  status: 'complete' | 'continue' | 'blocked';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  steering: string;
  completionSummary: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  disallowedDrift: string[];
  blockingReason: string;
}

interface AskUserDecision {
  shouldAskHuman: boolean;
  rationale: string;
  autoResponse: string;
}

type GateResolveResult = {
  action: 'approve' | 'reject';
  source: 'discord' | 'terminal' | 'timeout';
};

type WorkerPassResult = Awaited<ReturnType<typeof runWorkerPass>>;
type WorkerProgressReport = SessionWorkerProgressReport;

function deriveRequiredArtifacts(
  missingEvidence: string[],
  workerReport?: WorkerProgressReport,
): string[] {
  const fromMissing = missingEvidence.filter((item) =>
    /\b(file|artifact|report|rubric|spec|scenario|benchmark)\b/i.test(item),
  );
  const artifactHints = workerReport?.artifacts ?? [];
  return [...new Set([...fromMissing, ...artifactHints])].slice(0, 6);
}

function deriveRequiredValidation(
  requiredNextProof: string[],
  workerReport?: WorkerProgressReport,
): string[] {
  const fromProof = requiredNextProof.filter((item) =>
    /\b(test|validate|validation|benchmark|grader|check|prove|metric)\b/i.test(item),
  );
  const validations = workerReport?.validationCommands ?? [];
  return [...new Set([...fromProof, ...validations])].slice(0, 6);
}

function buildNextProofContract(
  goal: string,
  decision: Pick<
    MonitorDecision,
    | 'acceptedEvidence'
    | 'missingEvidence'
    | 'requiredNextProof'
    | 'disallowedDrift'
    | 'status'
    | 'completionSummary'
    | 'rationale'
  >,
  workerReport?: WorkerProgressReport,
): SessionNextProofContract | undefined {
  if (decision.status !== 'continue') return undefined;

  const requiredNextProof =
    decision.requiredNextProof.length > 0
      ? decision.requiredNextProof
      : ['Produce concrete evidence that the original request is complete.'];

  const missingEvidence =
    decision.missingEvidence.length > 0
      ? decision.missingEvidence
      : ['Concrete completion evidence tied to the original request.'];

  return {
    goal,
    acceptedEvidence: decision.acceptedEvidence,
    missingEvidence,
    requiredNextProof,
    requiredArtifacts: deriveRequiredArtifacts(missingEvidence, workerReport),
    requiredValidation: deriveRequiredValidation(requiredNextProof, workerReport),
    stopCondition:
      decision.completionSummary ||
      decision.rationale ||
      'Stop only once the missing proof is explicitly present.',
    avoidUntilProved: decision.disallowedDrift,
  };
}

function refreshSession(session: Session): Session {
  return sessions.getSession(session.id) ?? session;
}

function waitForGateResolution(session: Session, gateId: string): Promise<GateResolveResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: GateResolveResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    gateCoordinator.registerReceiptHandle(gateId, {
      type: session.provider === 'codex' ? 'codex' : 'claude',
      sessionId: session.id,
      resolve: (action, source) => settle({ action, source }),
      reject: () => settle({ action: 'reject', source: 'timeout' }),
    });
  });
}

function buildPermissionDetail(
  toolName: string,
  input: Record<string, unknown>,
  context: Parameters<ProviderCanUseTool>[2],
): string {
  const lines: string[] = [];

  lines.push(context.title || `Claude 需要人工批准后才能执行工具：${context.displayName || toolName}`);

  if (context.description) {
    lines.push(context.description);
  }

  if (context.decisionReason) {
    lines.push(`原因：${context.decisionReason}`);
  }

  if (context.blockedPath) {
    lines.push(`路径：${context.blockedPath}`);
  }

  const serializedInput = truncate(JSON.stringify(input), 500);
  if (serializedInput && serializedInput !== '{}') {
    lines.push(`输入：${serializedInput}`);
  }

  return lines.join('\n');
}

function createClaudePermissionHandler(
  session: Session,
  channel: SessionChannel,
): ProviderCanUseTool {
  return async (toolName, input, context) => {
    const liveSession = refreshSession(session);
    const detail = buildPermissionDetail(toolName, input, context);

    await handleAwaitingHuman(liveSession.id, detail, { source: 'claude' });

    const currentSession = refreshSession(liveSession);
    const gateId = currentSession.activeHumanGateId;
    if (!gateId) {
      return {
        behavior: 'deny',
        message: '未能创建人工门控',
        interrupt: true,
        toolUseID: context.toolUseID,
      };
    }

    const resolved = await waitForGateResolution(currentSession, gateId);

    await updateSessionState(currentSession.id, {
      type: 'human_resolved',
      sessionId: currentSession.id,
      source: 'claude',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: {
        action: resolved.action,
        source: resolved.source,
        toolName,
      },
    });

    if (resolved.action === 'approve') {
      return {
        behavior: 'allow',
        toolUseID: context.toolUseID,
      };
    }

    return {
      behavior: 'deny',
      message:
        resolved.source === 'timeout'
          ? '审批超时（5 分钟）'
          : resolved.source === 'terminal'
            ? '已在终端拒绝'
            : '已在 Discord 拒绝',
      interrupt: true,
      toolUseID: context.toolUseID,
    };
  };
}

function shouldUseClaudePermissionHandler(session: Session): boolean {
  if (session.provider !== 'claude') return false;
  if (session.mode === 'auto') return false;
  const effectiveMode = session.claudePermissionMode ?? config.claudePermissionMode;
  return effectiveMode !== 'bypass';
}

function applyWorkflowHook(
  session: Session,
  hook: Session['workflowState']['lastHook'],
  patch: Partial<Session['workflowState']> = {},
): Session {
  sessions.updateWorkflowState(session.id, (current) => ({
    ...current,
    ...patch,
    lastHook: hook,
  }));
  return refreshSession(session);
}

function extractPromptText(prompt: string | ContentBlock[]): string {
  if (typeof prompt === 'string') return prompt.trim();

  return prompt
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function summarizeWorkerText(text: string): string {
  const trimmed = text.trim();
  return trimmed ? truncate(trimmed, 6000) : '(no textual response)';
}

function extractClaimedCompletedOutcomes(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences
    .filter((sentence) =>
      /\b(completed?|finished?|validated?|implemented?|created?|added|wrote|fixed)\b/i.test(
        sentence,
      ),
    )
    .slice(0, 5);
}

function extractRemainingGaps(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences
    .filter((sentence) =>
      /\b(still|missing|need|remaining|not yet|left to|have not)\b/i.test(sentence),
    )
    .slice(0, 5);
}

function buildWorkerProgressReport(
  goal: string,
  result: Pick<
    WorkerPassResult,
    | 'text'
    | 'askedUser'
    | 'hadError'
    | 'success'
    | 'commandCount'
    | 'fileChangeCount'
    | 'recentCommands'
    | 'changedFiles'
  >,
): WorkerProgressReport {
  const meaningfulExecution = result.commandCount > 0 || result.fileChangeCount > 0;
  const changedFiles = result.changedFiles ?? [];
  const recentCommands = result.recentCommands ?? [];
  const validationCommands = recentCommands
    .filter((command) =>
      /\b(test|vitest|jest|pytest|npm test|pnpm test|yarn test|grader|validate|check|lint)\b/i.test(
        command,
      ),
    )
    .slice(0, 10);
  const blockers = result.hadError
    ? ['The worker pass reported an error or abnormal termination.']
    : [];

  return {
    originalGoal: goal,
    textualResponse: summarizeWorkerText(result.text),
    commandCount: result.commandCount,
    fileChangeCount: result.fileChangeCount,
    meaningfulExecutionEvidence: meaningfulExecution,
    providerReportedSuccess: result.success === null ? 'unknown' : result.success ? 'yes' : 'no',
    workerErrorsObserved: result.hadError,
    askedForHumanInput: result.askedUser,
    claimedCompletedOutcomes: extractClaimedCompletedOutcomes(result.text),
    artifacts: changedFiles,
    validationCommands,
    goalAssessment: result.text.trim()
      ? truncate(result.text.trim(), 1200)
      : meaningfulExecution
        ? 'The worker executed commands or changed files but did not provide an explicit textual assessment.'
        : 'The worker did not provide a substantive assessment of progress toward the goal.',
    remainingGaps: extractRemainingGaps(result.text),
    blockers,
  };
}

function summarizeWorkerPass(report: WorkerProgressReport): string {
  const changedFiles = report.artifacts;
  const recentCommands = report.validationCommands.length > 0 ? report.validationCommands : [];
  const parts = [
    `Textual response: ${report.textualResponse}`,
    `Command executions: ${report.commandCount}`,
    `File changes: ${report.fileChangeCount}`,
    `Meaningful execution evidence: ${report.meaningfulExecutionEvidence ? 'yes' : 'no'}`,
    `Asked for human input: ${report.askedForHumanInput ? 'yes' : 'no'}`,
    `Provider reported success: ${report.providerReportedSuccess}`,
    `Worker errors observed: ${report.workerErrorsObserved ? 'yes' : 'no'}`,
  ];

  if (report.claimedCompletedOutcomes.length > 0) {
    parts.push(`Claimed completed outcomes: ${report.claimedCompletedOutcomes.join(' | ')}`);
  }

  if (report.remainingGaps.length > 0) {
    parts.push(`Remaining gaps: ${report.remainingGaps.join(' | ')}`);
  }

  if (changedFiles.length > 0) {
    parts.push(`Changed files: ${changedFiles.join(', ')}`);
  }

  if (recentCommands.length > 0) {
    parts.push(`Validation commands: ${recentCommands.join(' | ')}`);
  }

  if (report.blockers.length > 0) {
    parts.push(`Blockers: ${report.blockers.join(' | ')}`);
  }

  return parts.join('\n');
}

function annotateInactivityAbort(text: string): string {
  const note = `[Worker pass aborted after ${Math.round(WORKER_IDLE_TIMEOUT_MS / 1000)}s of inactivity.]`;
  const trimmed = text.trim();
  if (trimmed.includes(note)) return trimmed;
  return trimmed ? `${trimmed}\n\n${note}` : note;
}

function createSyntheticResult(
  success: boolean,
  summary: string,
  sessionEnd = false,
): Extract<ProviderEvent, { type: 'result' }> {
  return {
    type: 'result',
    success,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
    errors: success ? [] : [summary],
    metadata: { sessionEnd },
  };
}

async function updatePanelState(
  session: Session,
  type: 'work_started' | 'awaiting_human' | 'errored',
  channel?: SessionChannel,
): Promise<void> {
  await updateSessionState(
    session.id,
    {
      type,
      sessionId: session.id,
      source: session.provider === 'codex' ? 'codex' : 'claude',
      confidence: 'high',
      timestamp: Date.now(),
    },
    channel ? { channel, sourceHint: session.provider } : { sourceHint: session.provider },
  );
}

function buildMonitorPrompt(
  goal: string,
  latestOutput: string,
  report: WorkerProgressReport,
  iteration: number,
  previousContract?: SessionNextProofContract,
): string {
  const parts = [
    `Original request:`,
    goal,
    '',
    `Latest worker pass (#${iteration}):`,
    latestOutput,
    '',
    'Worker progress report JSON:',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
  ];

  if (previousContract) {
    parts.push(
      'Previous proof contract JSON:',
      '```json',
      JSON.stringify(previousContract, null, 2),
      '```',
      '',
    );
  }

  parts.push(
    'Return JSON only in this schema:',
    '{',
    '  "status": "complete" | "continue" | "blocked",',
    '  "confidence": "high" | "medium" | "low",',
    '  "rationale": "Short explanation tied to the original request",',
    '  "steering": "Short plain-language summary of next steps",',
    '  "completionSummary": "Short summary of what is complete. Empty unless status is complete.",',
    '  "acceptedEvidence": ["Concrete evidence the monitor accepts"],',
    '  "missingEvidence": ["Concrete evidence still missing"],',
    '  "requiredNextProof": ["What the next worker pass must prove or produce"],',
    '  "disallowedDrift": ["Work the worker should avoid until the missing proof is produced"],',
    '  "blockingReason": "Why the task is blocked. Empty unless status is blocked."',
    '}',
    '',
    'Decision rules:',
    '- Return "complete" only when the latest pass contains explicit evidence that the original request is fully satisfied.',
    '- Return "continue" when there is progress or activity but the request is not clearly complete yet.',
    '- Return "blocked" only for a real blocker the worker cannot resolve autonomously.',
    '- If a previous proof contract is present, judge whether the latest pass actually satisfied that proof contract.',
    '',
    'Decide whether the request has actually been fulfilled. If not, provide concrete steering for the next pass focused on closing the remaining gap.',
  );

  return parts.join('\n');
}

function parseMonitorDecision(text: string): MonitorDecision | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<MonitorDecision>;
    if (
      parsed.status !== 'complete' &&
      parsed.status !== 'continue' &&
      parsed.status !== 'blocked'
    ) {
      return null;
    }
    const confidence =
      parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
        ? parsed.confidence
        : 'low';
    return {
      status: parsed.status,
      confidence,
      rationale: (parsed.rationale || '').trim(),
      steering: (parsed.steering || '').trim(),
      completionSummary: (parsed.completionSummary || '').trim(),
      acceptedEvidence: Array.isArray(parsed.acceptedEvidence)
        ? parsed.acceptedEvidence
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      missingEvidence: Array.isArray(parsed.missingEvidence)
        ? parsed.missingEvidence
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      requiredNextProof: Array.isArray(parsed.requiredNextProof)
        ? parsed.requiredNextProof
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      disallowedDrift: Array.isArray(parsed.disallowedDrift)
        ? parsed.disallowedDrift
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      blockingReason: (parsed.blockingReason || '').trim(),
    };
  } catch {
    return null;
  }
}

function normalizeMonitorDecision(
  workerResult: WorkerPassResult,
  decision: MonitorDecision,
): MonitorDecision {
  const hasStrongExecutionEvidence =
    workerResult.success === true &&
    !workerResult.hadError &&
    workerResult.commandCount > 0 &&
    workerResult.fileChangeCount >= 3;

  if (decision.status === 'complete' && !workerResult.text.trim() && !hasStrongExecutionEvidence) {
    return {
      status: 'continue',
      confidence: 'high',
      rationale:
        'The worker showed activity, but there is no explicit textual evidence that the original request is fully complete yet.',
      steering:
        'Inspect the latest changes, verify the remaining acceptance criteria against the original request, finish any missing work, and then report concrete completion evidence before stopping.',
      completionSummary: '',
      acceptedEvidence: [],
      missingEvidence: ['Explicit completion evidence tied to the original request.'],
      requiredNextProof: [
        'Report the completed outcomes, validation results, and why they satisfy the original goal.',
      ],
      disallowedDrift: ['Do not stop after silent activity or file changes alone.'],
      blockingReason: '',
    };
  }

  return decision;
}

function classifyWorkerPassForContinuation(workerResult: WorkerPassResult): MonitorDecision | null {
  const hasTextResponse = workerResult.text.trim().length > 0;
  const hasStrongExecutionEvidence =
    workerResult.success === true &&
    !workerResult.hadError &&
    workerResult.commandCount > 0 &&
    workerResult.fileChangeCount >= 3;

  if (workerResult.hadError || workerResult.success === false) {
    return {
      status: 'continue',
      confidence: 'high',
      rationale:
        'The latest pass encountered errors or did not complete successfully, so the task is still incomplete.',
      steering:
        'Identify the failing step, fix it directly, validate the result, and then report explicit completion evidence tied to the original request.',
      completionSummary: '',
      acceptedEvidence: [],
      missingEvidence: [
        'A successful pass without errors.',
        'Validation evidence tied to the original request.',
      ],
      requiredNextProof: ['Fix the failing step.', 'Run validation and report the result.'],
      disallowedDrift: [
        'Do not branch into unrelated improvements before the failing step is fixed.',
      ],
      blockingReason: '',
    };
  }

  if (!hasTextResponse && !hasStrongExecutionEvidence) {
    return {
      status: 'continue',
      confidence: 'high',
      rationale:
        workerResult.fileChangeCount > 0
          ? 'The worker showed limited activity, but there is still no explicit completion evidence for the original request.'
          : 'The worker made no substantive completion report and did not change files, so the original request is still incomplete.',
      steering:
        workerResult.fileChangeCount > 0
          ? 'Inspect the latest changes, finish the missing implementation or validation work, and then report explicit completion evidence before stopping.'
          : 'Re-anchor on the original request, make concrete progress in the repository, and then report explicit completion evidence before stopping.',
      completionSummary: '',
      acceptedEvidence:
        workerResult.fileChangeCount > 0
          ? ['Some implementation activity or file changes were observed.']
          : [],
      missingEvidence: ['Explicit completion evidence tied to the original request.'],
      requiredNextProof:
        workerResult.fileChangeCount > 0
          ? [
              'Explain what the latest changes accomplished.',
              'Run or report the missing validation tied to the goal.',
            ]
          : [
              'Make a concrete repository change or run a meaningful validation.',
              'Report how that progress advances the original goal.',
            ],
      disallowedDrift: [
        'Do not stop after exploration or silent activity.',
        'Do not assume progress is self-evident without explaining it.',
      ],
      blockingReason: '',
    };
  }

  return null;
}

function buildSteeringPrompt(
  goal: string,
  decision: MonitorDecision,
  iteration: number,
  proofContract?: SessionNextProofContract,
): string {
  const contract = proofContract ?? buildNextProofContract(goal, decision);
  const parts = [
    `Continue working on the same task. This is monitored continuation pass ${iteration}.`,
    '',
    `Original request:`,
    goal,
    '',
    `Monitor rationale: ${decision.rationale || 'The task is not complete yet.'}`,
  ];

  if (decision.steering) {
    parts.push('', 'Required next steps:', decision.steering);
  }

  if (decision.acceptedEvidence.length > 0) {
    parts.push(
      '',
      'Evidence already accepted:',
      ...decision.acceptedEvidence.map((item) => `- ${item}`),
    );
  }

  if (decision.missingEvidence.length > 0) {
    parts.push(
      '',
      'Evidence still missing:',
      ...decision.missingEvidence.map((item) => `- ${item}`),
    );
  }

  if (decision.requiredNextProof.length > 0) {
    parts.push(
      '',
      'Your next pass must prove:',
      ...decision.requiredNextProof.map((item) => `- ${item}`),
    );
  }

  if (decision.disallowedDrift.length > 0) {
    parts.push(
      '',
      'Avoid this drift until the missing proof is produced:',
      ...decision.disallowedDrift.map((item) => `- ${item}`),
    );
  }

  if (contract) {
    if (contract.requiredArtifacts.length > 0) {
      parts.push(
        '',
        'Required artifacts for this pass:',
        ...contract.requiredArtifacts.map((item) => `- ${item}`),
      );
    }
    if (contract.requiredValidation.length > 0) {
      parts.push(
        '',
        'Required validation for this pass:',
        ...contract.requiredValidation.map((item) => `- ${item}`),
      );
    }
    parts.push('', `Stop condition: ${contract.stopCondition}`);
  }

  parts.push(
    '',
    'Do not restate what is already done. Use the current repo/session state and focus only on the remaining gap. Do not stop until the remaining work is addressed or you hit a true blocker.',
  );

  return parts.join('\n');
}

function buildAskUserReviewPrompt(
  goal: string,
  questionsJson: string,
  latestOutput: string,
): string {
  return [
    'You are deciding whether a worker question actually requires a human.',
    '',
    'Return JSON only in this schema:',
    '{',
    '  "shouldAskHuman": true | false,',
    '  "rationale": "Short explanation",',
    '  "autoResponse": "If shouldAskHuman is false, provide the answer or direction the worker should use. Empty string otherwise."',
    '}',
    '',
    'Rules:',
    '- Ask the human only when there is a real, non-obvious branching decision that materially affects how to fulfill the original request.',
    '- If one option is clearly better for fulfilling the original request, do not ask the human; provide the answer directly.',
    '- If the worker is asking for permission or direction it can infer from the goal, do not ask the human.',
    '',
    'Original request:',
    goal,
    '',
    'Latest worker output before the question:',
    latestOutput || '(none)',
    '',
    'Worker question payload:',
    questionsJson,
  ].join('\n');
}

function parseAskUserDecision(text: string): AskUserDecision | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<AskUserDecision>;
    if (typeof parsed.shouldAskHuman !== 'boolean') return null;
    return {
      shouldAskHuman: parsed.shouldAskHuman,
      rationale: (parsed.rationale || '').trim(),
      autoResponse: (parsed.autoResponse || '').trim(),
    };
  } catch {
    return null;
  }
}

async function runWorkerPass(
  session: Session,
  channel: SessionChannel,
  prompt: string | ContentBlock[] | null,
  iteration: number,
  mode: 'prompt' | 'continue' = 'prompt',
) {
  session = applyWorkflowHook(session, 'before_worker_pass', {
    status: iteration > 1 ? 'retrying' : 'worker_running',
    iteration,
    awaitingHumanReason: undefined,
  });

  let lastEventAt = Date.now();
  let watchdogTriggered = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt >= WORKER_IDLE_TIMEOUT_MS) {
      watchdogTriggered = true;
      sessions.abortSessionWithReason(session.id, 'watchdog');
    }
  }, 1000);

  const stream =
    mode === 'continue'
      ? sessions.continueSessionWithOverrides(session.id, {
          canUseTool: shouldUseClaudePermissionHandler(session)
            ? createClaudePermissionHandler(session, channel)
            : undefined,
        })
      : sessions.sendPrompt(session.id, prompt as string | ContentBlock[], {
          canUseTool: shouldUseClaudePermissionHandler(session)
            ? createClaudePermissionHandler(session, channel)
            : undefined,
        });
  try {
    const result = await handleOutputStream(
      stream,
      channel,
      session.id,
      session.verbose,
      session.mode,
      session.provider,
      {
        onEvent: (_event: ProviderEvent) => {
          lastEventAt = Date.now();
        },
      },
    );
    const abortReason = sessions.consumeAbortReason(session.id);

    if (watchdogTriggered || abortReason === 'watchdog') {
      const stalledResult = {
        ...result,
        hadError: true,
        abortReason,
        text: annotateInactivityAbort(result.text),
      };
      const stalledReport = buildWorkerProgressReport('', stalledResult);
      applyWorkflowHook(session, 'on_stall', {
        status: 'retrying',
        lastWorkerSummary: summarizeWorkerPass(stalledReport),
        lastWorkerReport: stalledReport,
      });
      return stalledResult;
    }

    const resultReport = buildWorkerProgressReport('', result);
    // Only set monitor_review status if this is a monitor mode session
    // For non-monitor sessions, set to idle to allow immediate response
    applyWorkflowHook(session, 'after_worker_pass', {
      status: session.mode === 'monitor' ? 'monitor_review' : 'idle',
      lastWorkerSummary: summarizeWorkerPass(resultReport),
      lastWorkerReport: resultReport,
    });
    return {
      ...result,
      abortReason,
    };
  } finally {
    clearInterval(watchdog);
  }
}

async function runMonitorDecision(
  session: Session,
  goal: string,
  workerResult: Pick<
    WorkerPassResult,
    | 'text'
    | 'askedUser'
    | 'hadError'
    | 'success'
    | 'commandCount'
    | 'fileChangeCount'
    | 'recentCommands'
    | 'changedFiles'
  >,
  iteration: number,
): Promise<MonitorDecision> {
  applyWorkflowHook(session, 'before_monitor_review', {
    status: 'monitor_review',
    iteration,
  });
  let response = '';
  const report = buildWorkerProgressReport(goal, workerResult);
  const latestOutput = summarizeWorkerPass(report);
  const stream = sessions.sendMonitorPrompt(
    session.id,
    buildMonitorPrompt(
      goal,
      latestOutput,
      report,
      iteration,
      session.workflowState.nextProofContract,
    ),
  );
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      response += event.text;
    }
  }

  const parsed = parseMonitorDecision(response);
  if (parsed) return parsed;

  return {
    status: 'continue',
    confidence: 'low',
    rationale: 'The monitor response was invalid, so the safest default is to keep working.',
    steering:
      'Review the original request, identify the main missing gap, implement or validate that gap directly, and then report concrete evidence that the request is satisfied.',
    completionSummary: '',
    acceptedEvidence: [],
    missingEvidence: ['A valid monitor decision payload.'],
    requiredNextProof: [
      'Review the original request and produce concrete evidence for the remaining gap.',
    ],
    disallowedDrift: ['Do not assume completion without a valid monitor-visible explanation.'],
    blockingReason: '',
  };
}

async function runAskUserDecision(
  session: Session,
  goal: string,
  questionsJson: string,
  latestOutput: string,
): Promise<AskUserDecision> {
  let response = '';
  const stream = sessions.sendMonitorPrompt(
    session.id,
    buildAskUserReviewPrompt(goal, questionsJson, latestOutput),
  );
  for await (const event of stream) {
    if (event.type === 'text_delta') response += event.text;
  }

  const parsed = parseAskUserDecision(response);
  if (parsed) return parsed;

  return {
    shouldAskHuman: true,
    rationale: 'The monitor could not safely determine whether the question was necessary.',
    autoResponse: '',
  };
}

async function resolveAskUserIfPossible(
  session: Session,
  channel: SessionChannel,
  goal: string,
  workerResult: WorkerPassResult,
  iteration: number,
): Promise<{ handled: boolean; result?: WorkerPassResult }> {
  if (!workerResult.askedUser || !workerResult.askUserQuestionsJson) {
    return { handled: false };
  }

  const decision = await runAskUserDecision(
    session,
    goal,
    workerResult.askUserQuestionsJson,
    summarizeWorkerPass(buildWorkerProgressReport(goal, workerResult)),
  );

  if (decision.shouldAskHuman) {
    const detail =
      workerResult.askUserQuestionsJson ||
      decision.rationale ||
      'The worker hit a real non-obvious decision point.';
    applyWorkflowHook(session, 'on_human_question', {
      status: 'awaiting_human',
      iteration,
      awaitingHumanReason:
        decision.rationale || 'The worker hit a real non-obvious decision point.',
    });
    await updatePanelState(session, 'awaiting_human', channel);
    await handleAwaitingHuman(session.id, detail, {
      source: session.provider === 'codex' ? 'codex' : 'claude',
    });

    const latestSession = refreshSession(session);
    const gateId = latestSession.activeHumanGateId;
    if (gateId) {
      const resolved = await waitForGateResolution(latestSession, gateId);
      queueDigest(session.id, {
        kind: 'human',
        text:
          resolved.source === 'timeout'
            ? '人工门控超时，已回落为终端处理'
            : `人工门控已由${resolved.source === 'discord' ? 'Discord' : '终端'}${resolved.action === 'approve' ? '批准' : '拒绝'}`,
      });
    }

    return { handled: false };
  }

  queueDigest(session.id, {
    kind: 'monitor',
    text: `自动处理了一个提问分支：${truncate(
      decision.rationale || 'The better path was already implied by the original request.',
      120,
    )}`,
  });
  const autoDecision: MonitorDecision = {
    status: 'continue',
    confidence: 'medium',
    rationale: decision.rationale || 'The better path was already implied by the original request.',
    steering: decision.autoResponse || '',
    completionSummary: '',
    acceptedEvidence: [],
    missingEvidence: [],
    requiredNextProof: [],
    disallowedDrift: [],
    blockingReason: '',
  };
  applyWorkflowHook(session, 'after_monitor_decision', {
    status: 'retrying',
    iteration,
    lastMonitorRationale:
      decision.rationale || 'The better path was already implied by the original request.',
    lastMonitorDecision: autoDecision,
    nextProofContract: buildNextProofContract(goal, autoDecision),
  });
  const nextResult = await runWorkerPass(
    session,
    channel,
    decision.autoResponse ||
      'Choose the option that best fulfills the original request and continue.',
    iteration + 1,
    'prompt',
  );
  return { handled: true, result: nextResult };
}

async function runMonitorLoop(
  session: Session,
  channel: SessionChannel,
  goal: string,
  initialResult: WorkerPassResult,
): Promise<void> {
  let workerResult = initialResult;
  let currentSession = refreshSession(session);

  for (let iteration = 1; iteration <= MAX_MONITOR_ITERATIONS; iteration++) {
    const askUserResolution = await resolveAskUserIfPossible(
      currentSession,
      channel,
      goal,
      workerResult,
      iteration,
    );
    if (askUserResolution.handled) {
      workerResult = askUserResolution.result!;
      currentSession = refreshSession(currentSession);
      continue;
    }
    if (workerResult.askedUser) return;

    const preclassifiedDecision = classifyWorkerPassForContinuation(workerResult);
    if (preclassifiedDecision) {
      const workerReport = buildWorkerProgressReport(goal, workerResult);
      const nextProofContract = buildNextProofContract(goal, preclassifiedDecision, workerReport);
      currentSession = applyWorkflowHook(currentSession, 'on_stall', {
        status: 'retrying',
        iteration,
        lastWorkerSummary: summarizeWorkerPass(workerReport),
        lastWorkerReport: workerReport,
        lastMonitorRationale: preclassifiedDecision.rationale,
        lastMonitorDecision: preclassifiedDecision,
        nextProofContract,
      });
      await updatePanelState(currentSession, 'work_started', channel);
      queueDigest(currentSession.id, {
        kind: 'monitor',
        text: `第 ${iteration} 轮监控判断任务仍未完成：${truncate(preclassifiedDecision.rationale, 120)}`,
      });
      workerResult = await runWorkerPass(
        currentSession,
        channel,
        buildSteeringPrompt(goal, preclassifiedDecision, iteration, nextProofContract),
        iteration + 1,
        'prompt',
      );
      currentSession = refreshSession(currentSession);
      continue;
    }

    const rawDecision = await runMonitorDecision(currentSession, goal, workerResult, iteration);
    const decision = normalizeMonitorDecision(workerResult, rawDecision);
    const nextProofContract = buildNextProofContract(
      goal,
      decision,
      buildWorkerProgressReport(goal, workerResult),
    );
    currentSession = applyWorkflowHook(currentSession, 'after_monitor_decision', {
      status:
        decision.status === 'continue'
          ? 'retrying'
          : decision.status === 'complete'
            ? 'completed'
            : 'blocked',
      iteration,
      lastMonitorRationale: decision.rationale,
      lastMonitorDecision: decision,
      nextProofContract,
    });

    if (decision.status === 'complete') {
      currentSession = applyWorkflowHook(currentSession, 'on_complete', {
        status: 'completed',
        iteration,
        lastMonitorRationale: decision.rationale,
        lastMonitorDecision: decision,
        nextProofContract: undefined,
      });
      const summary =
        decision.completionSummary ||
        decision.rationale ||
        'The monitor judged the request complete.';
      await handleResultEvent(currentSession.id, createSyntheticResult(true, summary), summary);
      return;
    }

    if (decision.status === 'blocked') {
      currentSession = applyWorkflowHook(currentSession, 'on_blocked', {
        status: 'blocked',
        iteration,
        awaitingHumanReason: decision.rationale,
        lastMonitorRationale: decision.rationale,
        lastMonitorDecision: decision,
        nextProofContract: undefined,
      });
      const blocker = decision.rationale || 'The monitor reported a blocker.';
      await handleResultEvent(currentSession.id, createSyntheticResult(false, blocker), blocker);
      await updatePanelState(currentSession, 'awaiting_human', channel);
      await handleAwaitingHuman(currentSession.id, blocker, {
        source: currentSession.provider === 'codex' ? 'codex' : 'claude',
      });
      return;
    }

    await updatePanelState(currentSession, 'work_started', channel);
    queueDigest(currentSession.id, {
      kind: 'monitor',
      text: `第 ${iteration} 轮监控继续：${truncate(decision.rationale || 'continue working', 120)}`,
    });
    workerResult = await runWorkerPass(
      currentSession,
      channel,
      buildSteeringPrompt(goal, decision, iteration, nextProofContract),
      iteration + 1,
      'prompt',
    );
    currentSession = refreshSession(currentSession);
  }

  const limitDecision: MonitorDecision = {
    status: 'blocked',
    confidence: 'medium',
    rationale: 'Reached the continuation safety limit.',
    steering:
      'Review the latest worker report and decide whether to continue with tighter proof obligations or intervene manually.',
    completionSummary: '',
    acceptedEvidence: [],
    missingEvidence: ['Clear completion evidence for the original request.'],
    requiredNextProof: [
      'Produce a worker pass that directly addresses the latest missing evidence.',
    ],
    disallowedDrift: ['Do not keep iterating without narrowing the missing proof.'],
    blockingReason: 'Reached the continuation safety limit.',
  };
  applyWorkflowHook(currentSession, 'on_blocked', {
    status: 'blocked',
    iteration: MAX_MONITOR_ITERATIONS,
    awaitingHumanReason: 'Reached the continuation safety limit.',
    lastMonitorRationale: 'Reached the continuation safety limit.',
    lastMonitorDecision: limitDecision,
    nextProofContract: buildNextProofContract(goal, limitDecision),
  });
  const limitSummary =
    'Reached the continuation safety limit. Review the latest pass to decide whether more manual steering is needed.';
  await handleResultEvent(
    currentSession.id,
    createSyntheticResult(false, limitSummary),
    limitSummary,
  );
  await updatePanelState(currentSession, 'awaiting_human', channel);
  await handleAwaitingHuman(currentSession.id, limitSummary, {
    source: currentSession.provider === 'codex' ? 'codex' : 'claude',
  });
}

export async function executeSessionPrompt(
  session: Session,
  channel: SessionChannel,
  prompt: string | ContentBlock[],
  options: { updateMonitorGoal?: boolean } = {},
): Promise<void> {
  if (session.mode !== 'monitor') {
    await runWorkerPass(session, channel, prompt, 1, 'prompt');
    return;
  }

  const goalText = extractPromptText(prompt);
  if ((options.updateMonitorGoal ?? true) && goalText && !session.monitorGoal) {
    sessions.setMonitorGoal(session.id, goalText);
    session = sessions.getSession(session.id) ?? session;
  }

  const goal = session.monitorGoal || goalText;
  if (!goal) {
    await runWorkerPass(session, channel, prompt, 1, 'prompt');
    return;
  }

  const workerResult = await runWorkerPass(session, channel, prompt, 1, 'prompt');
  session = refreshSession(session);
  if (
    workerResult.abortReason === 'user' ||
    (workerResult.abortReason !== 'watchdog' && isAbortError(workerResult.text))
  ) {
    return;
  }
  await runMonitorLoop(session, channel, goal, workerResult);
}

export async function executeSessionContinue(
  session: Session,
  channel: SessionChannel,
): Promise<void> {
  const iteration = Math.max(session.workflowState.iteration, 1);
  let liveSession = refreshSession(session);
  if (session.mode !== 'monitor') {
    await runWorkerPass(liveSession, channel, null, iteration, 'continue');
    return;
  }
  const goal = liveSession.monitorGoal;
  if (!goal) {
    liveSession = applyWorkflowHook(liveSession, 'on_blocked', {
      status: 'blocked',
      iteration,
      awaitingHumanReason: 'Monitor mode is enabled but no monitor goal is saved for this session.',
      lastMonitorRationale:
        'Monitor mode is enabled but no monitor goal is saved for this session.',
      lastMonitorDecision: {
        status: 'blocked',
        confidence: 'high',
        rationale: 'Monitor mode is enabled but no monitor goal is saved for this session.',
        steering: '',
        completionSummary: '',
        acceptedEvidence: [],
        missingEvidence: ['A saved monitor goal for the active session.'],
        requiredNextProof: ['Set a monitor goal before continuing.'],
        disallowedDrift: [],
        blockingReason: 'Monitor mode is enabled but no monitor goal is saved for this session.',
      },
    });
    const summary =
      'Monitor mode is enabled but no monitor goal is saved for this session. Use `/agent goal goal:<text>` or send a fresh request to set one before continuing.';
    await handleResultEvent(liveSession.id, createSyntheticResult(false, summary), summary);
    await updatePanelState(liveSession, 'awaiting_human', channel);
    await handleAwaitingHuman(liveSession.id, summary, {
      source: liveSession.provider === 'codex' ? 'codex' : 'claude',
    });
    return;
  }
  const nextProofContract = liveSession.workflowState.nextProofContract;
  const workerResult = nextProofContract
    ? await runWorkerPass(
        liveSession,
        channel,
        buildSteeringPrompt(
          goal,
          liveSession.workflowState.lastMonitorDecision ?? {
            status: 'continue',
            confidence: 'medium',
            rationale:
              liveSession.workflowState.lastMonitorRationale || 'The task is still incomplete.',
            steering: '',
            completionSummary: '',
            acceptedEvidence: nextProofContract.acceptedEvidence,
            missingEvidence: nextProofContract.missingEvidence,
            requiredNextProof: nextProofContract.requiredNextProof,
            disallowedDrift: nextProofContract.avoidUntilProved,
            blockingReason: '',
          },
          iteration,
          nextProofContract,
        ),
        iteration,
        'prompt',
      )
    : await runWorkerPass(liveSession, channel, null, iteration, 'continue');
  liveSession = refreshSession(liveSession);
  await runMonitorLoop(liveSession, channel, goal, workerResult);
}
