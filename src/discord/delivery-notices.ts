import type { AnyThreadChannel, TextChannel } from 'discord.js';
import { buildDeliveryPlan } from './delivery-policy.ts';
import { deliver } from './delivery.ts';
import { config } from '../config.ts';

type DeliveryChannel = TextChannel | AnyThreadChannel;

function getDeliveryPolicy() {
  return {
    textChunkLimit: config.textChunkLimit ?? 2000,
    chunkMode: config.chunkMode ?? 'length',
    replyToMode: config.replyToMode ?? 'first',
    ackReaction: config.ackReaction ?? '👀',
  } as const;
}

export async function sendSystemNotice(
  channel: DeliveryChannel,
  sessionId: string,
  text: string,
  replyToMessageId?: string,
): Promise<void> {
  if (!text.trim()) return;
  const plan = buildDeliveryPlan({
    sessionId,
    chatId: channel.id,
    text,
    files: [],
    mode: 'system_notice',
    replyToMessageId,
    policy: getDeliveryPolicy(),
  });
  try {
    await deliver(channel, plan);
  } catch {
    // best effort, swallow errors
  }
}
