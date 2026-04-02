import type { Message } from 'discord.js';
import type { DeliveryPlan } from './delivery-policy.ts';

type ReplyCapableChannel = {
  send: (payload: Record<string, unknown>) => Promise<{ id: string }>;
  sendTyping?: () => Promise<unknown>;
  messages?: {
    edit: (messageId: string, payload: Record<string, unknown>) => Promise<unknown>;
  };
};

type ReactionCapableMessage = Pick<Message, 'react'>;

type SessionDeliveryState = {
  recentProgressMessageId?: string;
  recentFinalMessageId?: string;
};

const sessionState = new Map<string, SessionDeliveryState>();

function getSessionState(sessionId: string): SessionDeliveryState {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {});
  }
  return sessionState.get(sessionId)!;
}

export function resetDeliveryState(): void {
  sessionState.clear();
}

export async function sendTyping(channel: ReplyCapableChannel): Promise<void> {
  try {
    await channel.sendTyping?.();
  } catch {
    // ignore typing failures
  }
}

export async function sendAckReaction(
  message: ReactionCapableMessage,
  reaction: string,
): Promise<void> {
  if (!reaction) return;
  try {
    await message.react(reaction);
  } catch {
    // ignore reaction failures
  }
}

async function sendChunk(
  channel: ReplyCapableChannel,
  chunk: string,
  options: { replyToMessageId?: string; files?: string[] } = {},
): Promise<string> {
  const payload: Record<string, unknown> = { content: chunk };
  if (options.files?.length) payload.files = options.files;
  if (options.replyToMessageId) {
    payload.reply = { messageReference: options.replyToMessageId };
  }

  try {
    const message = await channel.send(payload);
    return message.id;
  } catch (error) {
    if (!options.replyToMessageId) {
      throw error;
    }

    const fallbackPayload: Record<string, unknown> = { content: chunk };
    if (options.files?.length) fallbackPayload.files = options.files;
    const fallbackMessage = await channel.send(fallbackPayload);
    return fallbackMessage.id;
  }
}

export async function deliver(
  channel: ReplyCapableChannel,
  plan: DeliveryPlan,
): Promise<string[]> {
  const state = getSessionState(plan.sessionId);

  if (plan.mode === 'progress_update') {
    const targetMessageId = plan.editTargetMessageId ?? state.recentProgressMessageId;
    if (targetMessageId && plan.chunks.length === 1 && plan.filesOnFirstChunk.length === 0) {
      try {
        await channel.messages?.edit(targetMessageId, { content: plan.chunks[0] });
        state.recentProgressMessageId = targetMessageId;
        return [targetMessageId];
      } catch {
        // fall through to send a fresh message
      }
    }
  }

  const ids: string[] = [];
  const replyToMode = plan.replyToMode ?? 'first';
  for (let index = 0; index < plan.chunks.length; index++) {
    const shouldReply =
      !!plan.replyToMessageId &&
      replyToMode !== 'off' &&
      (replyToMode === 'all' || index === 0);
    const id = await sendChunk(channel, plan.chunks[index], {
      replyToMessageId: shouldReply ? plan.replyToMessageId : undefined,
      files: index === 0 ? plan.filesOnFirstChunk : undefined,
    });
    ids.push(id);
  }

  if (ids.length > 0) {
    if (plan.mode === 'progress_update') {
      state.recentProgressMessageId = ids[ids.length - 1];
    } else {
      state.recentFinalMessageId = ids[ids.length - 1];
    }
  }

  return ids;
}
