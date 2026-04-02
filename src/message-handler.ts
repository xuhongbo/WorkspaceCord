import {
  ChannelType,
  type Message,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from './config.ts';
import { getSessionByChannel, updateSession } from './thread-manager.ts';
import { executeSessionPrompt } from './session-executor.ts';
import { isUserAllowed } from './utils.ts';
import { sendAckReaction, sendTyping, deliver } from './discord/delivery.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { registerMessageAttachments } from './discord/attachment-inbox.ts';
import { buildInboundEnvelope } from './discord/inbound-envelope.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

const lastMessageTime = new Map<string, number>();

export function resetMessageHandlerState(): void {
  lastMessageTime.clear();
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const channel = message.channel;
  const isSessionChannel = channel.type === ChannelType.GuildText;
  const isSubagentThread = channel.isThread();
  if (!isSessionChannel && !isSubagentThread) return;

  const session = getSessionByChannel(channel.id);
  if (!session) return;

  if (!isUserAllowed(message.author.id, config.allowedUsers, config.allowAllUsers)) {
    await (channel as SessionChannel)
      .send('You are not authorized to use this bot.')
      .catch(() => {});
    return;
  }

  const rateKey = `${message.author.id}:${channel.id}`;
  const now = Date.now();
  const last = lastMessageTime.get(rateKey) || 0;
  if (now - last < config.rateLimitMs) return;
  lastMessageTime.set(rateKey, now);

  if (session.isGenerating) {
    await (channel as SessionChannel)
      .send('*Agent is already generating. Stop it first with `/agent stop`.*')
      .catch(() => {});
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

  updateSession(session.id, { lastInboundMessageId: message.id });
  await executeSessionPrompt(session, channel as SessionChannel, envelope.renderedPrompt);

  if (session.type === 'subagent' && session.parentChannelId && message.guild) {
    const parentChannel = message.guild.channels.cache.get(session.parentChannelId) as
      | TextChannel
      | undefined;
    if (parentChannel?.isTextBased() && !parentChannel.isThread()) {
      const plan = buildDeliveryPlan({
        sessionId: session.id,
        chatId: parentChannel.id,
        text: [
          `✅ Subagent Finished: ${session.agentLabel}`,
          `<#${session.channelId}> has completed a pass. Review the thread for output.`,
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
      await deliver(parentChannel, plan).catch(() => {});
    }
  }
}
