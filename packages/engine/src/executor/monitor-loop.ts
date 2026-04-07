// Monitor mode orchestration: worker-monitor dual-agent loop
// Extracted from session-executor.ts for single-responsibility

import type { ThreadSession as Session, SessionMonitorFeedbackReport, SessionWorkerProgressReport } from '@workspacecord/core';
import { truncate } from '@workspacecord/core';
import { sendMonitorPrompt } from '../session/provider-runtime.ts';
import { getOutputPort } from '../output-port.ts';
import { waitForGateResolution } from './permission-gate.ts';
import { buildNextProofContract } from './proof-contract.ts';
import { applyWorkflowHook, refreshSession, updatePanelState } from './session-hooks.ts';
import { buildWorkerProgressReport, createSyntheticResult, summarizeWorkerPass } from './worker-report.ts';
import { buildAskUserReviewPrompt, buildMonitorPrompt, buildSteeringPrompt } from './monitor-prompts.ts';
import { parseAskUserDecision, parseMonitorDecision } from './monitor-parsers.ts';

const MAX_MONITOR_ITERATIONS = 6;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MonitorDecision extends SessionMonitorFeedbackReport {
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

export type WorkerPassResult = {
  text: string;
  askedUser: boolean;
  askUserQuestionsJson?: string;
  hadError: boolean;
  success: boolean | null;
  commandCount: number;
  fileChangeCount: number;
  recentCommands: string[];
  changedFiles: string[];
  abortReason?: 'user' | 'watchdog';
};

/** Callback to execute a worker pass — injected by session-executor. */
export type RunWorkerPassFn = (
  session: Session,
  channel: unknown,
  prompt: string | null,
  iteration: number,
  mode?: 'prompt' | 'continue',
) => Promise<WorkerPassResult>;

// ─── Monitor decision functions ─────────────────────────────────────────────

async function runMonitorDecision(
  session: Session,
  goal: string,
  workerResult: WorkerPassResult,
  iteration: number,
): Promise<MonitorDecision> {
  applyWorkflowHook(session, 'before_monitor_review', {
    status: 'monitor_review',
    iteration,
  });
  let response = '';
  const report = buildWorkerProgressReport(goal, workerResult);
  const latestOutput = summarizeWorkerPass(report);
  try {
    const stream = sendMonitorPrompt(
      session.id,
      buildMonitorPrompt(
        goal,
        latestOutput,
        JSON.stringify(report, null, 2),
        iteration,
        session.workflowState.nextProofContract,
      ),
    );
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        response += event.text;
      }
    }
  } catch (err: unknown) {
    console.error(`[SessionExecutor] monitor:error sessionId=${session.id} iteration=${iteration}`, err);
  }

  const parsed = parseMonitorDecision(response);
  if (parsed) {
    console.log(
      `[SessionExecutor] monitor:decision sessionId=${session.id} iteration=${iteration} status=${parsed.status} confidence=${parsed.confidence} rationale=${truncate(parsed.rationale, 100)}`,
    );
    return parsed;
  }

  console.warn(
    `[SessionExecutor] monitor:invalid sessionId=${session.id} iteration=${iteration} fallback=continue reason="invalid monitor response"`,
  );
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
  const stream = sendMonitorPrompt(
    session.id,
    buildAskUserReviewPrompt(goal, questionsJson, latestOutput),
  );
  for await (const event of stream) {
    if (event.type === 'text_delta') response += event.text;
  }

  const parsed = parseAskUserDecision(response);
  if (parsed) {
    console.log(
      `[SessionExecutor] askuser:decision sessionId=${session.id} shouldAskHuman=${parsed.shouldAskHuman} rationale=${truncate(parsed.rationale, 100)}`,
    );
    return parsed;
  }

  console.warn(
    `[SessionExecutor] askuser:invalid sessionId=${session.id} fallback=askHuman reason="invalid response"`,
  );
  return {
    shouldAskHuman: true,
    rationale: 'The monitor could not safely determine whether the question was necessary.',
    autoResponse: '',
  };
}

// ─── Decision normalization ─────────────────────────────────────────────────

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

// ─── Ask-user resolution ────────────────────────────────────────────────────

async function resolveAskUserIfPossible(
  session: Session,
  channel: unknown,
  goal: string,
  workerResult: WorkerPassResult,
  iteration: number,
  runWorkerPass: RunWorkerPassFn,
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
    await getOutputPort().handleAwaitingHuman(session.id, detail, {
      source: session.provider === 'codex' ? 'codex' : 'claude',
    });

    const latestSession = refreshSession(session);
    const gateId = latestSession.activeHumanGateId;
    if (gateId) {
      const resolved = await waitForGateResolution(latestSession, gateId);
      getOutputPort().queueDigest(session.id, {
        kind: 'human',
        text:
          resolved.source === 'timeout'
            ? '人工门控超时，已回落为终端处理'
            : `人工门控已由${resolved.source === 'discord' ? 'Discord' : '终端'}${resolved.action === 'approve' ? '批准' : '拒绝'}`,
      });
    }

    return { handled: false };
  }

  getOutputPort().queueDigest(session.id, {
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

// ─── Main monitor loop ──────────────────────────────────────────────────────

export async function runMonitorLoop(
  session: Session,
  channel: unknown,
  goal: string,
  initialResult: WorkerPassResult,
  runWorkerPass: RunWorkerPassFn,
): Promise<void> {
  console.log(
    `[SessionExecutor] monitor:loop-start sessionId=${session.id} goal=${truncate(goal, 80)}`,
  );
  let workerResult = initialResult;
  let currentSession = refreshSession(session);

  for (let iteration = 1; iteration <= MAX_MONITOR_ITERATIONS; iteration++) {
    const askUserResolution = await resolveAskUserIfPossible(
      currentSession,
      channel,
      goal,
      workerResult,
      iteration,
      runWorkerPass,
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
      getOutputPort().queueDigest(currentSession.id, {
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
      await getOutputPort().handleResult(currentSession.id, createSyntheticResult(true, summary), summary);
      console.log(
        `[SessionExecutor] monitor:complete sessionId=${currentSession.id} iteration=${iteration} rationale=${truncate(decision.rationale, 80)}`,
      );
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
      await getOutputPort().handleResult(currentSession.id, createSyntheticResult(false, blocker), blocker);
      await updatePanelState(currentSession, 'awaiting_human', channel);
      await getOutputPort().handleAwaitingHuman(currentSession.id, blocker, {
        source: currentSession.provider === 'codex' ? 'codex' : 'claude',
      });
      console.warn(
        `[SessionExecutor] monitor:blocked sessionId=${currentSession.id} iteration=${iteration} reason=${truncate(decision.rationale, 80)}`,
      );
      return;
    }

    await updatePanelState(currentSession, 'work_started', channel);
    getOutputPort().queueDigest(currentSession.id, {
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
  await getOutputPort().handleResult(
    currentSession.id,
    createSyntheticResult(false, limitSummary),
    limitSummary,
  );
  await updatePanelState(currentSession, 'awaiting_human', channel);
  await getOutputPort().handleAwaitingHuman(currentSession.id, limitSummary, {
    source: currentSession.provider === 'codex' ? 'codex' : 'claude',
  });
  console.warn(
    `[SessionExecutor] monitor:limit-reached sessionId=${currentSession.id} iterations=${MAX_MONITOR_ITERATIONS}`,
  );
}
