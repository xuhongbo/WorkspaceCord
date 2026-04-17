import { getSessionView } from '../session-context.ts';
import { getOutputPort } from '../output-port.ts';
import { gateCoordinator, stateMachine } from '@workspacecord/state';
import { truncate, config } from '@workspacecord/core';
import type { ThreadSession as Session } from '@workspacecord/core';
import type { ProviderCanUseTool } from '@workspacecord/providers';
import { enqueueBatchApproval, removeBatchApproval } from '../output/batch-approval-store.ts';

type GateResolveResult = {
  action: 'approve' | 'reject';
  source: 'discord' | 'terminal' | 'timeout';
};

function refreshSession(session: Session): Session {
  return getSessionView(session.id) ?? session;
}

async function recordPermissionDenial(
  session: Session,
  toolName: string,
  reason: string,
  source: string,
): Promise<void> {
  await getOutputPort().updateState(session.id, {
    type: 'permission_denied',
    sessionId: session.id,
    source: session.provider === 'codex' ? 'codex' : 'claude',
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { toolName, reason, source },
  });
  getOutputPort().queueDigest(session.id, {
    kind: 'denied',
    text: `⛔ 权限拒绝：${truncate(toolName, 40)} — ${truncate(reason, 80)}`,
  });
}

export function waitForGateResolution(
  session: Session,
  gateId: string,
): Promise<GateResolveResult> {
  console.log(`[SessionExecutor] gate:waiting sessionId=${session.id} gateId=${gateId}`);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: GateResolveResult) => {
      if (settled) return;
      settled = true;
      console.log(
        `[SessionExecutor] gate:resolved sessionId=${session.id} gateId=${gateId} action=${result.action} source=${result.source}`,
      );
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
  if (context.description) lines.push(context.description);
  if (context.decisionReason) lines.push(`原因：${context.decisionReason}`);
  if (context.blockedPath) lines.push(`路径：${context.blockedPath}`);

  const serializedInput = truncate(JSON.stringify(input), 500);
  if (serializedInput && serializedInput !== '{}') {
    lines.push(`输入：${serializedInput}`);
  }

  return lines.join('\n');
}

export function createClaudePermissionHandler(
  session: Session,
  _channel: unknown,
): ProviderCanUseTool {
  return async (toolName, input, context) => {
    const liveSession = refreshSession(session);
    const detail = buildPermissionDetail(toolName, input, context);

    console.log(
      `[SessionExecutor] permission:request sessionId=${liveSession.id} tool=${toolName} action=${context.displayName || toolName}`,
    );

    const projection = stateMachine.getSnapshot(liveSession.id);
    if (projection.batchApprovalMode) {
      const gateId = `batch-${liveSession.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timestamp = Date.now();
      const displayName = context.displayName || toolName;

      const batchAction = await new Promise<'approve' | 'reject'>((resolve) => {
        let settled = false;
        const settle = (action: 'approve' | 'reject') => {
          if (settled) return;
          settled = true;
          resolve(action);
        };

        const enqueueResult = enqueueBatchApproval(liveSession.id, {
          gateId,
          toolUseID: context.toolUseID,
          toolName: displayName,
          detail,
          timestamp,
          resolve: settle,
        });

        if (enqueueResult === 'overflow') {
          console.warn(
            `[SessionExecutor] permission:batch-overflow sessionId=${liveSession.id} tool=${toolName} reason="queue at capacity"`,
          );
          settle('reject');
          return;
        }

        stateMachine.enqueuePendingApproval(liveSession.id, {
          gateId,
          toolName: displayName,
          detail,
          timestamp,
        });
        // Nudge the status card so the new queue item shows up immediately
        void getOutputPort()
          .updateState(liveSession.id, {
            type: 'batch_approval_changed',
            sessionId: liveSession.id,
            source: liveSession.provider === 'codex' ? 'codex' : 'claude',
            confidence: 'high',
            timestamp,
            metadata: {
              enabled: true,
              pendingApprovals: stateMachine.getSnapshot(liveSession.id).pendingApprovals,
            },
          })
          .catch(() => {});
        getOutputPort().queueDigest(liveSession.id, {
          kind: 'batch',
          text: `已入批量审批队列：${truncate(toolName, 40)}`,
        });

        // Session abort (user /agent stop, bot shutdown, provider-side abort)
        // must unblock the pending canUseTool and drop its entry from both
        // queues. settle('reject') alone is not enough: if the abort came
        // from the provider rather than through abortSessionWithReason, the
        // zombie entry would inflate queue counts until the 100-item cap.
        const onAbort = () => {
          settle('reject');
          removeBatchApproval(liveSession.id, gateId);
          stateMachine.removePendingApproval(liveSession.id, gateId);
        };
        if (context.signal.aborted) onAbort();
        else context.signal.addEventListener('abort', onAbort, { once: true });
      });

      if (batchAction === 'approve') {
        console.log(
          `[SessionExecutor] permission:batch-approved sessionId=${liveSession.id} tool=${toolName}`,
        );
        return { behavior: 'allow', toolUseID: context.toolUseID };
      }

      console.log(
        `[SessionExecutor] permission:batch-rejected sessionId=${liveSession.id} tool=${toolName}`,
      );
      await recordPermissionDenial(liveSession, toolName, '批量拒绝', 'user');
      return {
        behavior: 'deny',
        message: '批量拒绝',
        interrupt: true,
        toolUseID: context.toolUseID,
      };
    }

    await getOutputPort().handleAwaitingHuman(liveSession.id, detail, { source: 'claude' });

    const currentSession = refreshSession(liveSession);
    const gateId = currentSession.activeHumanGateId;
    if (!gateId) {
      console.warn(
        `[SessionExecutor] permission:gate-failed sessionId=${currentSession.id} tool=${toolName} reason="failed to create gate"`,
      );
      return {
        behavior: 'deny',
        message: '未能创建人工门控',
        interrupt: true,
        toolUseID: context.toolUseID,
      };
    }

    const resolved = await waitForGateResolution(currentSession, gateId);

    if (resolved.action === 'approve') {
      console.log(
        `[SessionExecutor] permission:approved sessionId=${currentSession.id} tool=${toolName} source=${resolved.source}`,
      );
    } else {
      const reason =
        resolved.source === 'timeout'
          ? 'timeout'
          : resolved.source === 'terminal'
            ? 'terminal'
            : 'discord';
      console.log(
        `[SessionExecutor] permission:denied sessionId=${currentSession.id} tool=${toolName} source=${reason}`,
      );
    }

    await getOutputPort().updateState(currentSession.id, {
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
      return { behavior: 'allow', toolUseID: context.toolUseID };
    }

    const denyReason =
      resolved.source === 'timeout'
        ? '审批超时（5 分钟）'
        : resolved.source === 'terminal'
          ? '已在终端拒绝'
          : '已在 Discord 拒绝';

    await recordPermissionDenial(currentSession, toolName, denyReason, resolved.source);

    return {
      behavior: 'deny',
      message: denyReason,
      interrupt: true,
      toolUseID: context.toolUseID,
    };
  };
}

export function shouldUseClaudePermissionHandler(session: Session): boolean {
  if (session.provider !== 'claude') return false;
  if (session.mode === 'auto') return false;
  const effectiveMode = session.claudePermissionMode ?? config.claudePermissionMode;
  return effectiveMode !== 'bypass';
}
