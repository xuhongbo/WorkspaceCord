// 会话面板组件：封装单个会话的面板状态
// 从 panel-adapter.ts 提取，减少 Map 数量和模块复杂度

import type { SessionChannel } from '../types.ts';
import { StatusCard } from './status-card.ts';
import { SummaryHandler } from './summary-handler.ts';
import { InteractionCard } from './interaction-card.ts';
import type { SessionStateProjection, DigestItem } from '../state/types.ts';

export const MAX_DIGEST_QUEUE_SIZE = 20;

const INTERACTION_CARD_COOLDOWN_MS = 10000;

export function renderDigest(items: DigestItem[]): string {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    if (!grouped.has(item.kind)) grouped.set(item.kind, []);
    grouped.get(item.kind)!.push(item.text);
  }

  const lines: string[] = ['**最近进展**'];
  for (const [kind, texts] of grouped) {
    const latest = texts.slice(-2).join('；');
    lines.push(`- ${kind}：${latest}`);
    if (texts.length > 2) {
      lines.push(`- ${kind}：另有 ${texts.length - 2} 条已折叠`);
    }
  }

  return lines.join('\n');
}

export class SessionPanelComponent {
  readonly sessionId: string;
  readonly channel: SessionChannel;
  readonly statusCard: StatusCard;
  readonly summaryHandler: SummaryHandler;
  readonly interactionCard: InteractionCard;

  // Per-session state (moved from panel-adapter Maps)
  private digestQueue: DigestItem[] = [];
  private lastInteractionCardTime = 0;
  private lastActivity = Date.now();
  private cachedProjection: SessionStateProjection | null = null;

  constructor(sessionId: string, channel: SessionChannel) {
    this.sessionId = sessionId;
    this.channel = channel;
    this.statusCard = new StatusCard(channel);
    this.summaryHandler = new SummaryHandler(sessionId, channel.id, channel);
    this.interactionCard = new InteractionCard(channel);
  }

  async initialize(options: {
    statusCardMessageId?: string;
    initialTurn?: number;
    phase?: string;
    remoteHumanControl?: boolean;
    provider?: 'claude' | 'codex';
    permissionsSummary?: string;
  } = {}): Promise<void> {
    if (options.statusCardMessageId) {
      this.statusCard.adopt(options.statusCardMessageId);
    }
    await this.statusCard.initialize({
      turn: options.initialTurn ?? 1,
      phase: options.phase,
      updatedAt: Date.now(),
      remoteHumanControl: options.remoteHumanControl,
      provider: options.provider,
      permissionsSummary: options.permissionsSummary,
    });
  }

  updateProjection(projection: SessionStateProjection): void {
    this.lastActivity = Date.now();
    this.cachedProjection = projection;
  }

  getCachedProjection(): SessionStateProjection | null {
    return this.cachedProjection;
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  getMessageId(): string | undefined {
    return this.statusCard.getMessageId() ?? undefined;
  }

  queueDigest(item: DigestItem): void {
    const text = item.text.trim();
    if (!text) return;

    const last = this.digestQueue[this.digestQueue.length - 1];
    if (last && last.kind === item.kind && last.text === text) {
      return;
    }

    this.digestQueue.push({ kind: item.kind, text });
    if (this.digestQueue.length > MAX_DIGEST_QUEUE_SIZE) {
      this.digestQueue.splice(0, this.digestQueue.length - MAX_DIGEST_QUEUE_SIZE);
    }
  }

  getDigestQueue(): DigestItem[] {
    return [...this.digestQueue];
  }

  clearDigestQueue(): void {
    this.digestQueue = [];
  }

  checkInteractionCooldown(): boolean {
    const now = Date.now();
    return now - this.lastInteractionCardTime >= INTERACTION_CARD_COOLDOWN_MS;
  }

  getTimeSinceLastInteraction(): number {
    return Date.now() - this.lastInteractionCardTime;
  }

  recordInteractionCardTime(): void {
    this.lastInteractionCardTime = Date.now();
  }

  cleanup(): void {
    this.digestQueue = [];
    this.cachedProjection = null;
    this.lastInteractionCardTime = 0;
    this.lastActivity = 0;
  }
}
