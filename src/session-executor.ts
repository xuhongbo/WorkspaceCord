import type { SessionChannel } from './types.ts';
import * as sessions from './thread-manager.ts';
import { handleOutputStream } from './output-handler.ts';
import {
  handleResultEvent,
  handleAwaitingHuman,
  queueDigest,
  updateSessionState,
} from './panel-adapter.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import { createClaudePermissionHandler, shouldUseClaudePermissionHandler, waitForGateResolution } from './executor/permission-gate.ts';
import { isAbortError, truncate } from './utils.ts';
import { buildNextProofContract } from './executor/proof-contract.ts';
import { applyWorkflowHook, extractPromptText, refreshSession, updatePanelState } from './executor/session-hooks.ts';
import { annotateInactivityAbort, buildWorkerProgressReport, createSyntheticResult, summarizeWorkerPass } from './executor/worker-report.ts';
import { buildAskUserReviewPrompt, buildMonitorPrompt, buildSteeringPrompt } from './executor/monitor-prompts.ts';
import { parseAskUserDecision, parseMonitorDecision } from './executor/monitor-parsers.ts';
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

async function runWorkerPass(
  session: Session,
  channel: SessionChannel,
  prompt: string | ContentBlock[] | null,
  iteration: number,
  mode: 'prompt' | 'continue' = 'prompt',
) {
  console.log(
    `[SessionExecutor] worker:start sessionId=${session.id} iteration=${iteration} mode=${mode}`,
  );
  session = applyWorkflowHook(session, 'before_worker_pass', {
    status: iteration > 1 ? 'retrying' : 'worker_running',
    iteration,
    awaitingHumanReason: undefined,
  });

  let lastEventAt = Date.now();
  let watchdogTriggered = false;
  let watchdog: ReturnType<typeof setInterval>;

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
    watchdog = setInterval(() => {
      if (Date.now() - lastEventAt >= WORKER_IDLE_TIMEOUT_MS) {
        watchdogTriggered = true;
        console.warn(
          `[SessionExecutor] worker:watchdog sessionId=${session.id} iteration=${iteration} timeout=${WORKER_IDLE_TIMEOUT_MS}ms`,
        );
        sessions.abortSessionWithReason(session.id, 'watchdog');
      }
    }, 1000);

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
        text: annotateInactivityAbort(result.text, WORKER_IDLE_TIMEOUT_MS),
      };
      const stalledReport = buildWorkerProgressReport('', stalledResult);
      applyWorkflowHook(session, 'on_stall', {
        status: 'retrying',
        lastWorkerSummary: summarizeWorkerPass(stalledReport),
        lastWorkerReport: stalledReport,
      });
      console.warn(
        `[SessionExecutor] worker:stalled sessionId=${session.id} iteration=${iteration} reason=watchdog`,
      );
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
    console.log(
      `[SessionExecutor] worker:end sessionId=${session.id} iteration=${iteration} commands=${result.commandCount} files=${result.fileChangeCount} success=${result.success} hasError=${result.hadError}`,
    );
    return {
      ...result,
      abortReason,
    };
  } finally {
    clearInterval(watchdog!);
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
  try {
    const stream = sessions.sendMonitorPrompt(
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
  const stream = sessions.sendMonitorPrompt(
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
      await handleResultEvent(currentSession.id, createSyntheticResult(false, blocker), blocker);
      await updatePanelState(currentSession, 'awaiting_human', channel);
      await handleAwaitingHuman(currentSession.id, blocker, {
        source: currentSession.provider === 'codex' ? 'codex' : 'claude',
      });
      console.warn(
        `[SessionExecutor] monitor:blocked sessionId=${currentSession.id} iteration=${iteration} reason=${truncate(decision.rationale, 80)}`,
      );
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
  console.warn(
    `[SessionExecutor] monitor:limit-reached sessionId=${currentSession.id} iterations=${MAX_MONITOR_ITERATIONS}`,
  );
}

export async function executeSessionPrompt(
  session: Session,
  channel: SessionChannel,
  prompt: string | ContentBlock[],
  options: { updateMonitorGoal?: boolean } = {},
): Promise<void> {
  const goalText = extractPromptText(prompt);
  console.log(
    `[SessionExecutor] execute:prompt-start sessionId=${session.id} mode=${session.mode} goal=${truncate(goalText, 80)}`,
  );
  if (session.mode !== 'monitor') {
    await runWorkerPass(session, channel, prompt, 1, 'prompt');
    console.log(
      `[SessionExecutor] execute:prompt-end sessionId=${session.id} mode=${session.mode}`,
    );
    return;
  }

  if ((options.updateMonitorGoal ?? true) && goalText && !session.monitorGoal) {
    sessions.setMonitorGoal(session.id, goalText);
    session = sessions.getSession(session.id) ?? session;
  }

  const goal = session.monitorGoal || goalText;
  if (!goal) {
    await runWorkerPass(session, channel, prompt, 1, 'prompt');
    console.log(
      `[SessionExecutor] execute:prompt-end sessionId=${session.id} mode=${session.mode} reason="no-goal"`,
    );
    return;
  }

  const workerResult = await runWorkerPass(session, channel, prompt, 1, 'prompt');
  session = refreshSession(session);
  if (
    workerResult.abortReason === 'user' ||
    (workerResult.abortReason !== 'watchdog' && isAbortError(workerResult.text))
  ) {
    console.log(
      `[SessionExecutor] execute:prompt-end sessionId=${session.id} mode=${session.mode} reason=aborted abortReason=${workerResult.abortReason}`,
    );
    return;
  }
  await runMonitorLoop(session, channel, goal, workerResult);
  console.log(
    `[SessionExecutor] execute:prompt-end sessionId=${session.id} mode=monitor`,
  );
}

export async function executeSessionContinue(
  session: Session,
  channel: SessionChannel,
): Promise<void> {
  const iteration = Math.max(session.workflowState.iteration, 1);
  let liveSession = refreshSession(session);
  console.log(
    `[SessionExecutor] execute:continue-start sessionId=${liveSession.id} mode=${liveSession.mode} iteration=${iteration}`,
  );
  if (session.mode !== 'monitor') {
    await runWorkerPass(liveSession, channel, null, iteration, 'continue');
    console.log(
      `[SessionExecutor] execute:continue-end sessionId=${liveSession.id} mode=${liveSession.mode}`,
    );
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
    console.warn(
      `[SessionExecutor] execute:continue-end sessionId=${liveSession.id} reason="no-monitor-goal"`,
    );
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
            rationale:
              liveSession.workflowState.lastMonitorRationale || 'The task is still incomplete.',
            steering: '',
            acceptedEvidence: nextProofContract.acceptedEvidence,
            missingEvidence: nextProofContract.missingEvidence,
            requiredNextProof: nextProofContract.requiredNextProof,
            disallowedDrift: nextProofContract.avoidUntilProved,
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
  console.log(
    `[SessionExecutor] execute:continue-end sessionId=${liveSession.id} mode=monitor`,
  );
}
