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
  lastUsed?: number;
};

const sessionState = new Map<string, SessionDeliveryState>();

function getSessionState(sessionId: string): SessionDeliveryState {
  if (!sessionState.has(sessionId)) {
    sessionState.set(sessionId, {});
  }
  const state = sessionState.get(sessionId)!;
  state.lastUsed = Date.now();
  return state;
}

export function resetDeliveryState(): void {
  sessionState.clear();
}

function pruneStaleSessionStates(maxAgeMs = 5 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [sessionId, state] of sessionState) {
    if (!state.lastUsed || state.lastUsed < cutoff) {
      sessionState.delete(sessionId);
    }
  }
}

export function cleanupSessionDeliveryState(sessionId: string): void {
  sessionState.delete(sessionId);
}

export function cleanupStaleDeliveryStates(ageMs?: number): void {
  pruneStaleSessionStates(ageMs);
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

/**
 * Discord 发送出现 429 (rate limit) 时的最大重试次数。
 * discord.js 自己会处理大多数 bucket 限流，这里是对少数穿透到 application 层的场景做兜底。
 */
const SEND_MAX_RETRIES = 3;

function isDiscordRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; httpStatus?: unknown };
  return e.code === 429 || e.status === 429 || e.httpStatus === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithBackoff(
  channel: ReplyCapableChannel,
  payload: Record<string, unknown>,
): Promise<string> {
  let attempt = 0;
  // 基础退避 250ms → 500 → 1000，最多尝试 SEND_MAX_RETRIES 次
  while (true) {
    try {
      const message = await channel.send(payload);
      return message.id;
    } catch (error) {
      if (!isDiscordRateLimitError(error) || attempt >= SEND_MAX_RETRIES) {
        throw error;
      }
      const delayMs = 250 * 2 ** attempt;
      console.warn(
        `[Delivery] Discord rate-limited (attempt ${attempt + 1}/${SEND_MAX_RETRIES}), retrying in ${delayMs}ms`,
      );
      await sleep(delayMs);
      attempt++;
    }
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
    return await sendWithBackoff(channel, payload);
  } catch (error) {
    if (!options.replyToMessageId) {
      throw error;
    }

    const fallbackPayload: Record<string, unknown> = { content: chunk };
    if (options.files?.length) fallbackPayload.files = options.files;
    return sendWithBackoff(channel, fallbackPayload);
  }
}

export async function deliver(
  channel: ReplyCapableChannel,
  plan: DeliveryPlan,
): Promise<string[]> {
  pruneStaleSessionStates();
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
