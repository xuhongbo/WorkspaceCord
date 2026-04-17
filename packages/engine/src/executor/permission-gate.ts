import { getSessionView } from '../session-context.ts';
import { getOutputPort } from '../output-port.ts';
import { gateCoordinator } from '@workspacecord/state';
import { truncate, config } from '@workspacecord/core';
import type { ThreadSession as Session } from '@workspacecord/core';
import type { ProviderCanUseTool } from '@workspacecord/providers';

type GateResolveResult = {
  action: 'approve' | 'reject';
  source: 'discord' | 'terminal' | 'timeout';
};

function refreshSession(session: Session): Session {
  return getSessionView(session.id) ?? session;
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

export function shouldUseClaudePermissionHandler(session: Session): boolean {
  if (session.provider !== 'claude') return false;
  if (session.mode === 'auto') return false;
  const effectiveMode = session.claudePermissionMode ?? config.claudePermissionMode;
  return effectiveMode !== 'bypass';
}
