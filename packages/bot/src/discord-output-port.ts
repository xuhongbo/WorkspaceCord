// DiscordOutputPort — SessionOutputPort 的 Discord 实现
// 在 bot 启动时注册到 engine 的 OutputPort

import type { SessionOutputPort, OutputStreamResult } from '@workspacecord/engine/output-port';
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
 * Discord 实现的 SessionOutputPort。
 * 委托给 panel-adapter 和 output-handler 完成实际的 Discord 消息操作。
 */
export class DiscordOutputPort implements SessionOutputPort {
  async initializePanel(session: ThreadSession, channel: unknown): Promise<void> {
    await initializeSessionPanel(session.id, channel as SessionChannel);
  }

  async updateState(sessionId: string, event: PlatformEvent): Promise<void> {
    await updateSessionState(sessionId, event);
  }

  async handleResult(
    sessionId: string,
    resultEvent: ProviderEvent,
    summary?: string,
  ): Promise<void> {
    // Cast to the specific result event type expected by panel-adapter
    const event = resultEvent as Extract<ProviderEvent, { type: 'result' }>;
    await handleResultEvent(sessionId, event, summary ?? '');
  }

  async handleAwaitingHuman(
    sessionId: string,
    reason: string,
    options?: { source?: string },
  ): Promise<void> {
    await handleAwaitingHuman(sessionId, reason, options as { source?: 'claude' | 'codex' });
  }

  async relocatePanel(sessionId: string, channel: unknown): Promise<void> {
    await relocateSessionPanelToBottom(sessionId, channel as SessionChannel);
  }

  cleanupPanel(sessionId: string): void {
    cleanupSessionPanel(sessionId);
  }

  getProjection(sessionId: string): SessionStateProjection {
    return getSessionProjection(sessionId);
  }

  async handleOutputStream(
    stream: AsyncGenerator<ProviderEvent>,
    channel: unknown,
    sessionId: string,
    verbose = false,
    mode = 'auto',
    provider: ProviderName = 'claude',
    options: { onEvent?: (event: ProviderEvent) => void } = {},
  ): Promise<OutputStreamResult> {
    return handleOutputStream(
      stream,
      channel as SessionChannel,
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
