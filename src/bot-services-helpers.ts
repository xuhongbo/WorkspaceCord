import type { Client, TextChannel } from 'discord.js';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { deliver } from './discord/delivery.ts';
import { config } from './config.ts';
import { getAllSessions } from './thread-manager.ts';

const unmanagedCodexHintedSessions = new Set<string>();

export function clearCodexHint(sessionId: string): void {
  unmanagedCodexHintedSessions.delete(sessionId);
}

export async function cleanupOldMessages(client: Client): Promise<void> {
  if (!config.messageRetentionDays) return;
  const cutoff = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;
  for (const session of getAllSessions()) {
    if (session.type !== 'persistent') continue;
    try {
      const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (!channel) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      const old = messages.filter((m) => m.createdTimestamp < cutoff);
      if (old.size > 0) {
        await channel.bulkDelete(old, true);
      }
    } catch {
      /* channel may not exist */
    }
  }
}

export async function notifyUnmanagedCodexHint(
  client: Client,
  sessionId: string,
  channelId: string,
): Promise<void> {
  if (unmanagedCodexHintedSessions.has(sessionId)) return;
  unmanagedCodexHintedSessions.add(sessionId);

  try {
    const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) {
      console.warn(`[Codex Hint] Channel ${channelId} not found, skipping unmanaged hint for session ${sessionId}`);
      return;
    }
    const plan = buildDeliveryPlan({
      sessionId,
      chatId: channelId,
      text: [
        '💡 提示：此会话为非受管模式，仅支持状态监控',
        '如需远程审批能力，请使用 `workspacecord codex` 命令启动会话',
      ].join('\n'),
      files: [],
      mode: 'system_notice',
      policy: {
        textChunkLimit: config.textChunkLimit,
        chunkMode: config.chunkMode,
        replyToMode: config.replyToMode,
        ackReaction: config.ackReaction,
      },
    });
    await deliver(channel, plan);
  } catch (err) {
    console.warn('[Codex Hint] 发送非受管提示失败:', err);
  }
}
