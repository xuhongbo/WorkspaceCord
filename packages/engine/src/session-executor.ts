import type {
  ThreadSession as Session,
} from '@workspacecord/core';
import { isAbortError, truncate } from '@workspacecord/core';
import type { ProviderEvent, ContentBlock } from '@workspacecord/providers';
import { getOutputPort } from './output-port.ts';
import { getSession, abortSessionWithReason, consumeAbortReason, setMonitorGoal } from './session-registry.ts';
import { sendPrompt, continueSessionWithOverrides } from './session/provider-runtime.ts';
import { createClaudePermissionHandler, shouldUseClaudePermissionHandler } from './executor/permission-gate.ts';
import { applyWorkflowHook, extractPromptText, refreshSession, updatePanelState } from './executor/session-hooks.ts';
import { annotateInactivityAbort, buildWorkerProgressReport, createSyntheticResult, summarizeWorkerPass } from './executor/worker-report.ts';
import { buildSteeringPrompt } from './executor/monitor-prompts.ts';
import { runMonitorLoop } from './executor/monitor-loop.ts';

const WORKER_IDLE_TIMEOUT_MS = 180_000; // 3 minutes

// ─── Worker Pass ────────────────────────────────────────────────────────────

async function runWorkerPass(
  session: Session,
  channel: unknown,
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
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const WATCHDOG_SLOW_INTERVAL = 5000;
  const WATCHDOG_FAST_INTERVAL = 1000;
  const WATCHDOG_FAST_THRESHOLD = 120_000;

  const stream =
    mode === 'continue'
      ? continueSessionWithOverrides(session.id, {
          canUseTool: shouldUseClaudePermissionHandler(session)
            ? createClaudePermissionHandler(session, channel)
            : undefined,
        })
      : sendPrompt(session.id, prompt as string | ContentBlock[], {
          canUseTool: shouldUseClaudePermissionHandler(session)
            ? createClaudePermissionHandler(session, channel)
            : undefined,
        });
  try {
    const scheduleWatchdog = () => {
      const idleMs = Date.now() - lastEventAt;
      if (idleMs >= WORKER_IDLE_TIMEOUT_MS) {
        watchdogTriggered = true;
        console.warn(
          `[SessionExecutor] worker:watchdog sessionId=${session.id} iteration=${iteration} timeout=${WORKER_IDLE_TIMEOUT_MS}ms`,
        );
        abortSessionWithReason(session.id, 'watchdog');
        return;
      }
      const delay = idleMs >= WATCHDOG_FAST_THRESHOLD
        ? WATCHDOG_FAST_INTERVAL
        : WATCHDOG_SLOW_INTERVAL;
      watchdogTimer = setTimeout(scheduleWatchdog, delay);
    };
    watchdogTimer = setTimeout(scheduleWatchdog, WATCHDOG_SLOW_INTERVAL);

    const result = await getOutputPort().handleOutputStream(
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
    const abortReason = consumeAbortReason(session.id);

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
    if (watchdogTimer) clearTimeout(watchdogTimer);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function executeSessionPrompt(
  session: Session,
  channel: unknown,
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
    setMonitorGoal(session.id, goalText);
    session = getSession(session.id) ?? session;
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
  await runMonitorLoop(session, channel, goal, workerResult, runWorkerPass);
  console.log(
    `[SessionExecutor] execute:prompt-end sessionId=${session.id} mode=monitor`,
  );
}

export async function executeSessionContinue(
  session: Session,
  channel: unknown,
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
    await getOutputPort().handleResult(liveSession.id, createSyntheticResult(false, summary), summary);
    await updatePanelState(liveSession, 'awaiting_human', channel);
    await getOutputPort().handleAwaitingHuman(liveSession.id, summary, {
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
  await runMonitorLoop(liveSession, channel, goal, workerResult, runWorkerPass);
  console.log(
    `[SessionExecutor] execute:continue-end sessionId=${liveSession.id} mode=monitor`,
  );
}
