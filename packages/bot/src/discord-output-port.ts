// DiscordOutputPort — SessionOutputPort 的 Discord 实现
// 在 bot 启动时注册到 engine 的 OutputPort

import type {
  SessionOutputPort,
  OutputStreamResult,
  ChannelRef,
  ResultEventData,
} from '@workspacecord/engine/output-port';
import type { ProviderEvent } from '@workspacecord/providers';
import type { ThreadSession, ProviderName } from '@workspacecord/core';
import type { PlatformEvent, DigestItem, SessionStateProjection } from '@workspacecord/state';

import {
  initializeSessionPanel,
  updateSessionState,
  handleResultEvent,
  handleAwaitingHuman,
  relocateSessionPanelToBottom,
  cleanupSessionPanel,
  getSessionProjection,
  queueDigest,
  flushDigest,
} from './panel-adapter.ts';
import { handleOutputStream } from './output-handler.ts';
import type { SessionChannel } from './discord-types.ts';

/**
 * 将 engine 传来的 ChannelRef 解为 Discord 的 SessionChannel。
 * 集中在 adapter 边界做一次 narrow，避免散落在各处 `as SessionChannel`。
 */
function asSessionChannel(ref: ChannelRef): SessionChannel {
  return ref as SessionChannel;
}

/**
 * 构造一个最小的 result-event 对象，供 panel-adapter 的历史接口使用。
 * 这里故意只填充 panel 真正读取的字段，不再 cast 整个 ProviderEvent 联合。
 */
function toResultEvent(
  data: ResultEventData,
): Extract<ProviderEvent, { type: 'result' }> {
  return {
    type: 'result',
    success: data.success,
    costUsd: data.costUsd,
    durationMs: data.durationMs,
    numTurns: data.numTurns,
    errors: data.errors,
    metadata: data.metadata,
  };
}

/**
 * Discord 实现的 SessionOutputPort。
 * 委托给 panel-adapter 和 output-handler 完成实际的 Discord 消息操作。
 */
export class DiscordOutputPort implements SessionOutputPort {
  async initializePanel(session: ThreadSession, channel: ChannelRef): Promise<void> {
    await initializeSessionPanel(session.id, asSessionChannel(channel));
  }

  async updateState(
    sessionId: string,
    event: PlatformEvent,
    options?: { channel?: ChannelRef },
  ): Promise<void> {
    await updateSessionState(
      sessionId,
      event,
      options?.channel ? { channel: asSessionChannel(options.channel) } : undefined,
    );
  }

  async handleResult(
    sessionId: string,
    resultEvent: ResultEventData,
    summary?: string,
  ): Promise<void> {
    await handleResultEvent(sessionId, toResultEvent(resultEvent), summary ?? '');
  }

  async handleAwaitingHuman(
    sessionId: string,
    reason: string,
    options?: { source?: string },
  ): Promise<void> {
    await handleAwaitingHuman(sessionId, reason, options as { source?: 'claude' | 'codex' });
  }

  async relocatePanel(sessionId: string, channel: ChannelRef): Promise<void> {
    await relocateSessionPanelToBottom(sessionId, asSessionChannel(channel));
  }

  cleanupPanel(sessionId: string): void {
    cleanupSessionPanel(sessionId);
  }

  getProjection(sessionId: string): SessionStateProjection {
    return getSessionProjection(sessionId);
  }

  async handleOutputStream(
    stream: AsyncGenerator<ProviderEvent>,
    channel: ChannelRef,
    sessionId: string,
    verbose = false,
    mode = 'auto',
    provider: ProviderName = 'claude',
    options: { onEvent?: (event: ProviderEvent) => void } = {},
  ): Promise<OutputStreamResult> {
    return handleOutputStream(
      stream,
      asSessionChannel(channel),
      sessionId,
      verbose,
      mode,
      provider,
      options,
    );
  }

  queueDigest(sessionId: string, item: DigestItem): void {
    queueDigest(sessionId, item);
  }

  async flushDigest(sessionId: string): Promise<void> {
    await flushDigest(sessionId);
  }
}
