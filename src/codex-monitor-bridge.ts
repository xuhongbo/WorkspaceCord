import type { TextChannel, AnyThreadChannel } from 'discord.js';
import { resolveCodexSessionFromMonitor } from './thread-manager.ts';
import { normalizeCodexEvent } from './state/event-normalizer.ts';
import { registerExistingStatusCard, updateSessionState } from './panel-adapter.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

function isSessionChannel(channel: unknown): channel is SessionChannel {
  return !!channel && typeof channel === 'object' && 'send' in channel && 'messages' in channel;
}

export async function handleCodexMonitorStateChange(
  resolveChannel: (channelId: string) => unknown,
  monitorSessionId: string,
  observedState: string,
  eventKey: string,
  extra: { cwd?: string; permissionDetail?: { command: string } },
): Promise<boolean> {
  const session = resolveCodexSessionFromMonitor(monitorSessionId, extra.cwd);
  if (!session) {
    // 会话未找到，可能是快速注册尚未完成或失败
    // 不再直接丢弃，而是记录日志供调试
    console.debug(
      `[CodexMonitorBridge] Session not found for ${monitorSessionId}, ` +
      `state: ${observedState}, cwd: ${extra.cwd || 'unknown'}`
    );
    return false;
  }

  const channel = resolveChannel(session.channelId);
  if (!isSessionChannel(channel)) return false;

  if (session.statusCardMessageId) {
    await registerExistingStatusCard(session.id, channel, session.statusCardMessageId);
  }

  const platformEvent = normalizeCodexEvent(eventKey, session.id, {
    ...extra,
    observedState,
    monitorSessionId,
  });
  if (!platformEvent) return false;

  await updateSessionState(session.id, platformEvent, {
    sourceHint: 'codex',
    channel,
  });
  return true;
}
