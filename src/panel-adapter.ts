// 实时作战面板集成适配器
// 将新组件集成到现有 output-handler / session-executor / shell-handler

import type { TextChannel, AnyThreadChannel } from 'discord.js';
import { StatusCard } from './discord/status-card.ts';
import { SummaryHandler } from './discord/summary-handler.ts';
import { InteractionCard } from './discord/interaction-card.ts';
import { StateMachine } from './state/state-machine.ts';
import { toPlatformEvent, mapPlatformEventToState } from './state/event-normalizer.ts';
import type { ProviderEvent } from './providers/types.ts';
import * as sessions from './thread-manager.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import type {
  PlatformEvent,
  SessionStateSnapshot,
  DigestItem,
  UnifiedState,
} from './state/types.ts';
import { performanceTracker } from './monitoring/performance-tracker.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

// 全局状态机实例
const stateMachine = new StateMachine();

// 会话到组件的映射
const sessionComponents = new Map<string, {
  channel: SessionChannel;
  statusCard: StatusCard;
  summaryHandler: SummaryHandler;
  interactionCard: InteractionCard;
}>();

// 会话摘要队列（低频聚合）
const sessionDigests = new Map<string, DigestItem[]>();
const MAX_DIGEST_QUEUE_SIZE = 20;

// 批量更新控制
const BATCH_UPDATE_DELAY_MS = 500;
const pendingUpdates = new Map<string, {
  snapshot: SessionStateSnapshot;
  timer: NodeJS.Timeout;
}>();

// 交互卡限流控制
const INTERACTION_CARD_COOLDOWN_MS = 10000;
const lastInteractionCardTime = new Map<string, number>();

// 内存控制
const SESSION_INACTIVE_TIMEOUT_MS = 3600000; // 1 小时
const sessionLastActivity = new Map<string, number>();
const sessionStateSnapshots = new Map<string, SessionStateSnapshot>();

function getSessionComponents(sessionId: string): {
  channel: SessionChannel;
  statusCard: StatusCard;
  summaryHandler: SummaryHandler;
  interactionCard: InteractionCard;
} | undefined {
  return sessionComponents.get(sessionId);
}

function ensureSession(sessionId: string): SessionStateSnapshot {
  return stateMachine.ensureSession(sessionId);
}

function resolveProviderSource(
  sessionId: string,
  fallback: 'claude' | 'codex' = 'claude',
): 'claude' | 'codex' {
  const session = sessions.getSession(sessionId);
  return session?.provider === 'codex' ? 'codex' : fallback;
}

export async function initializeSessionPanel(
  sessionId: string,
  channel: SessionChannel,
  options: {
    statusCardMessageId?: string;
    initialTurn?: number;
    phase?: string;
  } = {},
): Promise<void> {
  performanceTracker.startSessionDiscovery(sessionId);

  const existing = getSessionComponents(sessionId);
  if (existing) {
    performanceTracker.endSessionDiscovery(sessionId, { cached: true });
    return;
  }

  const statusCard = new StatusCard(channel);
  const session = sessions.getSession(sessionId);
  if (options.statusCardMessageId) {
    statusCard.adopt(options.statusCardMessageId);
  }
  await statusCard.initialize({
    turn: options.initialTurn ?? 1,
    phase: options.phase,
    updatedAt: Date.now(),
    remoteHumanControl: session?.remoteHumanControl,
    provider: session?.provider,
  });

  const summaryHandler = new SummaryHandler(channel, statusCard);
  const interactionCard = new InteractionCard(channel);

  sessionComponents.set(sessionId, {
    channel,
    statusCard,
    summaryHandler,
    interactionCard,
  });

  sessions.setStatusCardBinding(sessionId, {
    messageId: statusCard.getMessageId() ?? options.statusCardMessageId,
  });

  const snapshot = ensureSession(sessionId);
  if (snapshot.turn <= 0) {
    stateMachine.updateSession(sessionId, { turn: options.initialTurn ?? 1 });
  }

  sessionLastActivity.set(sessionId, Date.now());
  performanceTracker.endSessionDiscovery(sessionId, { cached: false });
}

export async function registerExistingStatusCard(
  sessionId: string,
  channel: SessionChannel,
  statusCardMessageId: string,
): Promise<void> {
  await initializeSessionPanel(sessionId, channel, {
    statusCardMessageId,
  });
}

export async function updateSessionState(
  sessionId: string,
  event: ProviderEvent | PlatformEvent,
  options: {
    sourceHint?: 'claude' | 'codex';
    channel?: SessionChannel;
  } = {},
): Promise<SessionStateSnapshot | null> {
  const updateKey = `${sessionId}:state`;
  performanceTracker.startStateUpdate(updateKey);

  if (!getSessionComponents(sessionId) && options.channel) {
    const session = sessions.getSession(sessionId);
    await initializeSessionPanel(sessionId, options.channel, {
      statusCardMessageId: session?.statusCardMessageId,
      initialTurn: session?.currentTurn || 1,
    });
  }

  const platformEvent = toPlatformEvent(
    event,
    sessionId,
    options.sourceHint ?? resolveProviderSource(sessionId),
  );
  if (!platformEvent) {
    performanceTracker.endStateUpdate(updateKey, { skipped: true });
    return null;
  }

  const snapshot = stateMachine.applyPlatformEvent(platformEvent);
  sessionLastActivity.set(sessionId, Date.now());
  sessionStateSnapshots.set(sessionId, snapshot);

  // 批量更新：500ms 内的多次更新合并为一次
  const pending = pendingUpdates.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
  }

  const timer = setTimeout(async () => {
    const components = getSessionComponents(sessionId);
    const session = sessions.getSession(sessionId);
    if (components) {
      try {
        await components.statusCard.update(snapshot.state, {
          turn: snapshot.turn,
          updatedAt: snapshot.updatedAt,
          phase: snapshot.phase,
          remoteHumanControl: session?.remoteHumanControl,
          provider: session?.provider,
        });
      } catch (error) {
        // Discord API 限流降级：仅记录错误，不阻塞流程
        console.error(`状态卡更新失败 (${sessionId}):`, error);
      }
    }
    pendingUpdates.delete(sessionId);
    performanceTracker.endStateUpdate(updateKey, { batched: true });
  }, BATCH_UPDATE_DELAY_MS);

  pendingUpdates.set(sessionId, { snapshot, timer });

  sessions.updateSession(sessionId, {
    currentTurn: snapshot.turn,
    humanResolved: snapshot.humanResolved,
  });

  return snapshot;
}

export async function handleResultEvent(
  sessionId: string,
  event: Extract<ProviderEvent, { type: 'result' }>,
  textContent: string,
): Promise<void> {
  const components = getSessionComponents(sessionId);
  if (!components) return;

  const snapshot = ensureSession(sessionId);
  if (snapshot.turn <= 0) {
    stateMachine.updateSession(sessionId, { turn: 1 });
  }

  const isSessionEnd = event.metadata?.sessionEnd === true;
  const source = resolveProviderSource(sessionId);
  await components.interactionCard.hide();
  sessions.setCurrentInteractionMessage(sessionId, undefined);

  if (isSessionEnd) {
    await components.summaryHandler.sendEndingSummary(textContent);
    await updateSessionState(sessionId, {
      type: 'session_ended',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result' },
    });
  } else if (!event.success) {
    const failureText =
      textContent.trim() || event.errors.join('\n').trim() || '任务失败';
    await components.summaryHandler.sendTurnFailure(failureText, snapshot.turn);
    await updateSessionState(sessionId, {
      type: 'errored',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result', errors: event.errors },
    });
  } else {
    const before = ensureSession(sessionId);
    const session = sessions.getSession(sessionId);
    await components.summaryHandler.sendTurnSummary(textContent, before.turn);
    const after = stateMachine.incrementTurn(sessionId);
    sessions.updateSession(sessionId, {
      currentTurn: after.turn,
      humanResolved: false,
    });
    await components.statusCard.update('idle', {
      turn: after.turn,
      updatedAt: Date.now(),
      phase: stateMachine.getStateLabel('idle'),
      remoteHumanControl: session?.remoteHumanControl,
      provider: session?.provider,
    });
    stateMachine.updateSession(sessionId, {
      state: 'idle',
      phase: stateMachine.getStateLabel('idle'),
      isCompleted: false,
      isWaitingHuman: false,
    });
  }
}

export async function handleAwaitingHuman(
  sessionId: string,
  detail: string,
  options: {
    source?: 'claude' | 'codex';
  } = {},
): Promise<string | null> {
  const components = getSessionComponents(sessionId);
  if (!components) return null;
  const session = sessions.getSession(sessionId);

  // 交互卡限流：同一会话 10 秒内最多创建 1 个
  const lastTime = lastInteractionCardTime.get(sessionId) ?? 0;
  const now = Date.now();
  if (now - lastTime < INTERACTION_CARD_COOLDOWN_MS) {
    console.warn(`交互卡创建限流 (${sessionId}): 距上次创建仅 ${now - lastTime}ms`);
    return null;
  }

  let snapshot = ensureSession(sessionId);
  if (snapshot.turn <= 0) {
    snapshot = stateMachine.incrementTurn(sessionId);
  }

  const provider = session?.provider ?? resolveProviderSource(sessionId);
  const remoteHumanControl = session?.remoteHumanControl !== false;
  const gate = gateCoordinator.createGate({
    sessionId,
    provider,
    type: 'binary_approval',
    isBlocking: true,
    supportsRemoteDecision: remoteHumanControl,
    summary: detail,
    detail,
    turn: snapshot.turn,
  });

  await updateSessionState(sessionId, {
    type: 'awaiting_human',
    sessionId,
    source: options.source ?? provider,
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { detail },
  });

  const messageId = await components.interactionCard.show(sessionId, snapshot.turn, detail, {
    remoteHumanControl,
    provider,
  });
  gateCoordinator.bindDiscordMessage(gate.id, messageId);
  lastInteractionCardTime.set(sessionId, now);
  sessionLastActivity.set(sessionId, now);

  sessions.updateSession(sessionId, {
    currentTurn: snapshot.turn,
    humanResolved: false,
    currentInteractionMessageId: messageId,
    activeHumanGateId: gate.id,
  });
  sessions.setCurrentInteractionMessage(sessionId, messageId);
  return messageId;
}

export function queueDigest(sessionId: string, item: DigestItem): void {
  const text = item.text.trim();
  if (!text) return;

  if (!sessionDigests.has(sessionId)) {
    sessionDigests.set(sessionId, []);
  }
  const queue = sessionDigests.get(sessionId)!;
  const last = queue[queue.length - 1];
  if (last && last.kind === item.kind && last.text === text) {
    return;
  }

  queue.push({ kind: item.kind, text });
  if (queue.length > MAX_DIGEST_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_DIGEST_QUEUE_SIZE);
  }
}

export function getDigestQueue(sessionId: string): DigestItem[] {
  return [...(sessionDigests.get(sessionId) ?? [])];
}

export function clearDigestQueue(sessionId: string): void {
  sessionDigests.delete(sessionId);
}

function renderDigest(items: DigestItem[]): string {
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

export async function flushDigest(sessionId: string): Promise<void> {
  const components = getSessionComponents(sessionId);
  if (!components) return;

  const queue = getDigestQueue(sessionId);
  if (queue.length === 0) return;

  await components.summaryHandler.sendDigestSummary(renderDigest(queue));
  clearDigestQueue(sessionId);
}

export function mapPlatformEventTypeToUnifiedState(type: PlatformEvent['type']): UnifiedState | null {
  return mapPlatformEventToState(type);
}

export function getStateMachine(): StateMachine {
  return stateMachine;
}

// 清理失活会话的状态快照
export function cleanupInactiveSessions(): void {
  const now = Date.now();
  for (const [sessionId, lastActivity] of sessionLastActivity) {
    if (now - lastActivity > SESSION_INACTIVE_TIMEOUT_MS) {
      sessionStateSnapshots.delete(sessionId);
      sessionLastActivity.delete(sessionId);
      console.log(`清理失活会话状态快照: ${sessionId}`);
    }
  }
}

// 获取性能统计
export function getPerformanceStats(): {
  discoveryLatency: ReturnType<typeof performanceTracker.getMetricStats>;
  updateLatency: ReturnType<typeof performanceTracker.getMetricStats>;
  activeSessions: number;
  snapshotCount: number;
} {
  return {
    discoveryLatency: performanceTracker.getMetricStats('session_discovery_latency'),
    updateLatency: performanceTracker.getMetricStats('state_update_latency'),
    activeSessions: sessionComponents.size,
    snapshotCount: sessionStateSnapshots.size,
  };
}

// 定期清理和性能快照
let cleanupInterval: NodeJS.Timeout | null = null;

export function startPerformanceMonitoring(): void {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    cleanupInactiveSessions();
    performanceTracker.takeSnapshot();
    performanceTracker.cleanup();
  }, 60000); // 每分钟执行一次
}

export function stopPerformanceMonitoring(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// 生成性能报告
export function generatePerformanceReport(): string {
  return performanceTracker.generateReport();
}
