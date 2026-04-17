// SessionOutputPort — 引擎与表现层之间的抽象接口
// engine 通过此接口与 Discord (或其他平台) 通信，无需直接依赖 discord.js
//
// bot 包在启动时调用 registerOutputPort() 注入 Discord 实现

import type { ProviderEvent } from '@workspacecord/providers';
import type { ThreadSession, ProviderName } from '@workspacecord/core';
import type { PlatformEvent, DigestItem, SessionStateProjection } from '@workspacecord/state';

/**
 * ChannelRef — 平台相关的会话信道句柄的不透明类型。
 * engine 只做透传，从不解构；bot 实现在内部 narrow 回 Discord 的 SessionChannel。
 * 保持为 unknown 的别名而非品牌类型，既让 engine 层无法直接操作它，
 * 又避免调用方反复做 `as ChannelRef` 这样的噪音转换。
 */
export type ChannelRef = unknown;

/**
 * 结果事件在 OutputPort 面的最小契约 —— 只暴露 UI 层面板真正需要的字段，
 * 避免把完整的 ProviderEvent 判别联合穿透到表现层。
 */
export interface ResultEventData {
  success: boolean;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  errors: string[];
  metadata?: { sessionEnd?: boolean };
}

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
  initializePanel(session: ThreadSession, channel: ChannelRef): Promise<void>;
  updateState(
    sessionId: string,
    event: PlatformEvent,
    options?: { channel?: ChannelRef },
  ): Promise<void>;
  handleResult(sessionId: string, resultEvent: ResultEventData, summary?: string): Promise<void>;
  handleAwaitingHuman(
    sessionId: string,
    reason: string,
    options?: { source?: string },
  ): Promise<void>;
  relocatePanel(sessionId: string, channel: ChannelRef): Promise<void>;
  cleanupPanel(sessionId: string): void;
  getProjection(sessionId: string): SessionStateProjection;

  // ─── 输出流 ──────────────────────────────────────────────────────────
  handleOutputStream(
    stream: AsyncGenerator<ProviderEvent>,
    channel: ChannelRef,
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
