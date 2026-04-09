import {
  ChannelType,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { SessionChannel } from './discord-types.ts';
import { config, isUserAllowed } from '@workspacecord/core';
import { getSessionByChannel, updateSession } from '@workspacecord/engine/session-registry';
import { executeSessionPrompt } from '@workspacecord/engine/session-executor';
import { sendAckReaction, sendTyping, deliver } from './discord/delivery.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { sendSystemNotice } from './discord/delivery-notices.ts';
import { registerMessageAttachments } from './discord/attachment-inbox.ts';
import { buildInboundEnvelope } from './discord/inbound-envelope.ts';
import { relocateSessionPanelToBottom } from './panel-adapter.ts';

const lastMessageTime = new Map<string, number>();
const lastRelocationTime = new Map<string, number>();
const RATE_LIMIT_TTL_MS = 60 * 60 * 1000; // 1 hour
const RELOCATION_COOLDOWN_MS = 10_000; // 10 seconds between relocations per session

// Periodically prune stale rate-limit entries to prevent unbounded growth
let pruneInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_TTL_MS;
  for (const [key, time] of lastMessageTime) {
    if (time < cutoff) lastMessageTime.delete(key);
  }
  for (const [key, time] of lastRelocationTime) {
    if (time < cutoff) lastRelocationTime.delete(key);
  }
}, RATE_LIMIT_TTL_MS);

export function resetMessageHandlerState(): void {
  lastMessageTime.clear();
  lastRelocationTime.clear();
}

export function stopMessageHandler(): void {
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
  lastMessageTime.clear();
  lastRelocationTime.clear();
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const channel = message.channel;
  const isSessionChannel = channel.type === ChannelType.GuildText;
  const isSubagentThread = channel.isThread();
  if (!isSessionChannel && !isSubagentThread) return;

  const session = getSessionByChannel(channel.id);
  if (!session) {
    console.warn(`[MessageHandler] Session not found for channel ${channel.id} — ignoring message`);
    return;
  }

  if (!isUserAllowed(message.author.id, config.allowedUsers, config.allowAllUsers)) {
    console.warn(`[MessageHandler] Unauthorized attempt by user ${message.author.id} in channel ${channel.id} (session ${session.id})`);
    await sendSystemNotice(channel as SessionChannel, session.id, '你没有权限使用此 Bot。');
    return;
  }

  const rateKey = `${message.author.id}:${channel.id}`;
  const now = Date.now();
  const last = lastMessageTime.get(rateKey) || 0;
  if (now - last < config.rateLimitMs) {
    const remaining = Math.ceil((config.rateLimitMs - (now - last)) / 1000);
    (channel as SessionChannel).send(`⏳ 发送过于频繁，请 ${remaining} 秒后再试。`)
      .then(msg => setTimeout(() => msg.delete().catch((e) => console.warn(`[MessageHandler] Failed to delete rate-limit notice: ${(e as Error).message}`)), 5000))
      .catch((e) => console.warn(`[MessageHandler] Failed to send rate-limit notice: ${(e as Error).message}`));
    return;
  }
  lastMessageTime.set(rateKey, now);

  if (session.isGenerating) {
    console.log(`[MessageHandler] Already generating in session ${session.id} — ignoring message`);
    await sendSystemNotice(
      channel as SessionChannel,
      session.id,
      '*Agent 正在执行中，请先使用 `/agent stop` 停止。*',
      message.reference?.messageId ?? undefined,
    );
    return;
  }

  await sendTyping(channel as SessionChannel);
  await sendAckReaction(message, config.ackReaction);

  const attachments = await registerMessageAttachments(
    session.id,
    message.id,
    Array.from(message.attachments.values()),
  );

  const envelope = buildInboundEnvelope({
    sessionId: session.id,
    chatId: channel.id,
    messageId: message.id,
    replyToMessageId: message.reference?.messageId,
    userId: message.author.id,
    username: message.author.username ?? message.author.displayName ?? 'unknown',
    timestampIso: new Date(message.createdTimestamp ?? Date.now()).toISOString(),
    text: message.content ?? '',
    attachments,
  });

  if (!envelope.text.trim() && envelope.attachments.length === 0) return;

  console.log(`[MessageHandler] Prompt submitted to session ${session.id} (${envelope.text.length} chars)`);
  updateSession(session.id, { lastInboundMessageId: message.id });
  const lastReloc = lastRelocationTime.get(session.id) ?? 0;
  if (now - lastReloc >= RELOCATION_COOLDOWN_MS) {
    lastRelocationTime.set(session.id, now);
    await Promise.resolve(
      relocateSessionPanelToBottom(session.id, channel as SessionChannel),
    ).catch((e) => console.warn(`[MessageHandler] Panel relocation failed (${session.id}): ${(e as Error).message}`));
  }
  await executeSessionPrompt(session, channel as SessionChannel, envelope.renderedPrompt);

  if (session.type === 'subagent' && session.parentChannelId && message.guild) {
    const parentChannel = message.guild.channels.cache.get(session.parentChannelId) as
      | TextChannel
      | undefined;
    if (parentChannel?.isTextBased() && !parentChannel.isThread()) {
      console.log(`[MessageHandler] Subagent ${session.id} completed — notifying parent channel ${parentChannel.id}`);
      const plan = buildDeliveryPlan({
        sessionId: session.id,
        chatId: parentChannel.id,
        text: [
          `✅ 子任务完成：${session.agentLabel}`,
          `<#${session.channelId}> 已完成一轮执行，请查看子频道了解详情。`,
        ].join('\n\n'),
        files: [],
        mode: 'system_notice',
        policy: {
          textChunkLimit: config.textChunkLimit ?? 2000,
          chunkMode: config.chunkMode ?? 'length',
          replyToMode: config.replyToMode ?? 'first',
          ackReaction: config.ackReaction ?? '👀',
        },
      });
      await deliver(parentChannel, plan).catch((e) => console.warn(`[MessageHandler] Parent channel notification failed (${session.id}): ${(e as Error).message}`));
    }
  }
}
