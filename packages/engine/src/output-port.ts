// SessionOutputPort — 引擎与表现层之间的抽象接口
// engine 通过此接口与 Discord (或其他平台) 通信，无需直接依赖 discord.js
//
// bot 包在启动时调用 registerOutputPort() 注入 Discord 实现

import type { ProviderEvent } from '@workspacecord/providers';
import type { ThreadSession, ProviderName } from '@workspacecord/core';
import type { PlatformEvent, DigestItem, SessionStateProjection } from '@workspacecord/state';

/** Output stream result returned by handleOutputStream */
export interface OutputStreamResult {
  text: string;
  askedUser: boolean;
  askUserQuestionsJson?: string;
  hadError: boolean;
  success: boolean | null;
  commandCount: number;
  fileChangeCount: number;
  recentCommands: string[];
  changedFiles: string[];
}

/**
 * 引擎的输出端口 — 由 bot 包提供 Discord 实现。
 * engine 通过此接口与表现层通信，无需知道 Discord。
 */
export interface SessionOutputPort {
  // ─── 面板生命周期 ────────────────────────────────────────────────────
  initializePanel(session: ThreadSession, channel: unknown): Promise<void>;
  updateState(sessionId: string, event: PlatformEvent, options?: { channel?: unknown }): Promise<void>;
  handleResult(sessionId: string, resultEvent: ProviderEvent, summary?: string): Promise<void>;
  handleAwaitingHuman(
    sessionId: string,
    reason: string,
    options?: { source?: string },
  ): Promise<void>;
  relocatePanel(sessionId: string, channel: unknown): Promise<void>;
  cleanupPanel(sessionId: string): void;
  getProjection(sessionId: string): SessionStateProjection;

  // ─── 输出流 ──────────────────────────────────────────────────────────
  handleOutputStream(
    stream: AsyncGenerator<ProviderEvent>,
    channel: unknown,
    sessionId: string,
    verbose?: boolean,
    mode?: string,
    provider?: ProviderName,
    options?: { onEvent?: (event: ProviderEvent) => void },
  ): Promise<OutputStreamResult>;

  // ─── 摘要 ────────────────────────────────────────────────────────────
  queueDigest(sessionId: string, item: DigestItem): void;
  flushDigest(sessionId: string): Promise<void>;
}

// ─── 模块级注册 ──────────────────────────────────────────────────────────────

let outputPort: SessionOutputPort | null = null;

export function registerOutputPort(port: SessionOutputPort): void {
  outputPort = port;
}

export function getOutputPort(): SessionOutputPort {
  if (!outputPort) {
    throw new Error('OutputPort not registered. Call registerOutputPort() during bot startup.');
  }
  return outputPort;
}
