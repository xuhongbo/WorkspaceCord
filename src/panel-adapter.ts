// 实时作战面板集成适配器
// 将新组件集成到现有 output-handler / session-executor / shell-handler

import type { TextChannel, AnyThreadChannel } from 'discord.js';
import { StatusCard } from './discord/status-card.ts';
import { SummaryHandler } from './discord/summary-handler.ts';
import { InteractionCard } from './discord/interaction-card.ts';
import { StatusCardProjectionRenderer } from './discord/status-card-projection-renderer.ts';
import { stateMachine, type StateMachine } from './state/state-machine.ts';
import { toPlatformEvent, mapPlatformEventToState } from './state/event-normalizer.ts';
import type { ProviderEvent } from './providers/types.ts';
import * as sessions from './thread-manager.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import type {
  PlatformEvent,
  SessionStateProjection,
  DigestItem,
  UnifiedState,
} from './state/types.ts';
import { performanceTracker } from './monitoring/performance-tracker.ts';
import { clearPendingAnswers } from './output/answer-store.ts';
import { cleanupSessionDeliveryState } from './discord/delivery.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

// 会话到组件的映射
const sessionComponents = new Map<string, {
  channel: SessionChannel;
  statusCard: StatusCard;
  summaryHandler: SummaryHandler;
  interactionCard: InteractionCard;
}>();
const sessionInitializationPromises = new Map<string, Promise<void>>();

// 会话摘要队列（低频聚合）
const sessionDigests = new Map<string, DigestItem[]>();
const MAX_DIGEST_QUEUE_SIZE = 20;

// 批量更新控制
const BATCH_UPDATE_DELAY_MS = 500;
const statusCardProjectionRenderer = new StatusCardProjectionRenderer();

// 交互卡限流控制
const INTERACTION_CARD_COOLDOWN_MS = 10000;
const lastInteractionCardTime = new Map<string, number>();

// 内存控制
const SESSION_INACTIVE_TIMEOUT_MS = 3600000; // 1 小时
const sessionLastActivity = new Map<string, number>();
const sessionStateProjections = new Map<string, SessionStateProjection>();

function getSessionComponents(sessionId: string): {
  channel: SessionChannel;
  statusCard: StatusCard;
  summaryHandler: SummaryHandler;
  interactionCard: InteractionCard;
} | undefined {
  return sessionComponents.get(sessionId);
}

function getSessionProjection(sessionId: string): SessionStateProjection {
  return stateMachine.getSnapshot(sessionId);
}

function ensureProjectionTurn(
  sessionId: string,
  turn = 1,
  event = 'turn_bootstrap',
): SessionStateProjection {
  const projection = getSessionProjection(sessionId);
  if (projection.turn > 0) return projection;

  const initialized = stateMachine.setTurn(sessionId, turn, event);
  cacheProjection(sessionId, initialized);
  return initialized;
}

function cacheProjection(sessionId: string, projection: SessionStateProjection): void {
  sessionLastActivity.set(sessionId, Date.now());
  sessionStateProjections.set(sessionId, projection);
}

function syncSessionRuntimeState(sessionId: string, projection: SessionStateProjection): void {
  sessions.updateSession(sessionId, {
    currentTurn: projection.turn,
    humanResolved: projection.humanResolved,
  });
}

function createStatusCardProjectionContext(sessionId: string) {
  const components = getSessionComponents(sessionId);
  if (!components) return undefined;
  const session = sessions.getSession(sessionId);
  return {
    statusCard: components.statusCard,
    remoteHumanControl: session?.remoteHumanControl,
    provider: session?.provider,
    permissionsSummary: session ? sessions.getSessionPermissionSummary(session) : undefined,
  };
}

async function renderProjectionToStatusCard(
  sessionId: string,
  projection: SessionStateProjection,
): Promise<void> {
  await statusCardProjectionRenderer.renderNow(
    sessionId,
    projection,
    createStatusCardProjectionContext(sessionId),
  );
}

async function scheduleProjectionRender(
  sessionId: string,
  projection: SessionStateProjection,
  updateKey: string,
): Promise<void> {
  statusCardProjectionRenderer.schedule(
    sessionId,
    projection,
    createStatusCardProjectionContext(sessionId),
    BATCH_UPDATE_DELAY_MS,
    () => performanceTracker.endStateUpdate(updateKey, { batched: true }),
  );
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

  const pendingInitialization = sessionInitializationPromises.get(sessionId);
  if (pendingInitialization) {
    await pendingInitialization;
    performanceTracker.endSessionDiscovery(sessionId, { cached: true });
    return;
  }

  const initialization = (async () => {
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
      permissionsSummary: session ? sessions.getSessionPermissionSummary(session) : undefined,
    });

    const summaryHandler = new SummaryHandler(sessionId, channel.id, channel);
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

    const projection = ensureProjectionTurn(
      sessionId,
      options.initialTurn ?? 1,
      'panel_initialized',
    );
    cacheProjection(sessionId, projection);
  })();

  sessionInitializationPromises.set(sessionId, initialization);
  try {
    await initialization;
    performanceTracker.endSessionDiscovery(sessionId, { cached: false });
  } finally {
    sessionInitializationPromises.delete(sessionId);
  }
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
): Promise<SessionStateProjection | null> {
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

  const session = sessions.getSession(sessionId);
  if (
    platformEvent.source === 'codex' &&
    platformEvent.type === 'completed' &&
    session?.isGenerating
  ) {
    performanceTracker.endStateUpdate(updateKey, { skipped: true });
    return getSessionProjection(sessionId);
  }

  const projection = stateMachine.applyPlatformEvent(platformEvent);
  cacheProjection(sessionId, projection);
  await scheduleProjectionRender(sessionId, projection, updateKey);
  syncSessionRuntimeState(sessionId, projection);

  return projection;
}

export async function handleResultEvent(
  sessionId: string,
  event: Extract<ProviderEvent, { type: 'result' }>,
  textContent: string,
  attachments: string[] = [],
): Promise<void> {
  const components = getSessionComponents(sessionId);
  if (!components) return;

  const projection = ensureProjectionTurn(sessionId, 1, 'turn_bootstrap');

  const isSessionEnd = event.metadata?.sessionEnd === true;
  const source = resolveProviderSource(sessionId);
  await components.interactionCard.hide();
  sessions.setCurrentInteractionMessage(sessionId, undefined);

  if (isSessionEnd) {
    await components.summaryHandler.sendEndingSummary(textContent, attachments);
    await updateSessionState(sessionId, {
      type: 'session_ended',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result' },
    });
  } else if (!event.success) {
    const session = sessions.getSession(sessionId);
    const failureText =
      textContent.trim() || event.errors.join('\n').trim() || '任务失败';
    await components.summaryHandler.sendTurnFailure(
      failureText,
      projection.turn,
      session?.lastInboundMessageId,
      attachments,
    );
    await updateSessionState(sessionId, {
      type: 'errored',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result', errors: event.errors },
    });
  } else {
    const beforeProjection = getSessionProjection(sessionId);
    const session = sessions.getSession(sessionId);
    await components.summaryHandler.sendTurnSummary(
      textContent,
      beforeProjection.turn,
      session?.lastInboundMessageId,
      attachments,
    );
    const projectionAfterTurn = stateMachine.advanceTurnToIdle(sessionId);
    syncSessionRuntimeState(sessionId, projectionAfterTurn);
    await renderProjectionToStatusCard(sessionId, projectionAfterTurn);
    cacheProjection(sessionId, projectionAfterTurn);
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

  const projection = ensureProjectionTurn(sessionId, 1, 'turn_bootstrap');

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
    turn: projection.turn,
  });

  await updateSessionState(sessionId, {
    type: 'awaiting_human',
    sessionId,
    source: options.source ?? provider,
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { detail },
  });

  const messageId = await components.interactionCard.show(sessionId, projection.turn, detail, {
    remoteHumanControl,
    provider,
  });
  gateCoordinator.bindDiscordMessage(gate.id, messageId);
  lastInteractionCardTime.set(sessionId, now);
  cacheProjection(sessionId, getSessionProjection(sessionId));

  sessions.updateSession(sessionId, {
    currentTurn: projection.turn,
    humanResolved: false,
    currentInteractionMessageId: messageId,
    activeHumanGateId: gate.id,
  });
  sessions.setCurrentInteractionMessage(sessionId, messageId);
  return messageId;
}

export async function relocateSessionPanelToBottom(
  sessionId: string,
  channel?: SessionChannel,
): Promise<void> {
  let components = getSessionComponents(sessionId);
  if (!components && channel) {
    const session = sessions.getSession(sessionId);
    await initializeSessionPanel(sessionId, channel, {
      statusCardMessageId: session?.statusCardMessageId,
      initialTurn: session?.currentTurn || 1,
    });
    components = getSessionComponents(sessionId);
  }
  if (!components) return;

  let statusRelocation:
    | {
        oldMessageId?: string;
        newMessageId: string;
      }
    | null = null;

  try {
    statusRelocation = await components.statusCard.recreateAtBottom();
  } catch (error) {
    console.warn(`状态消息迁移失败 (${sessionId})：`, error);
    return;
  }

  let digestRelocation = { oldMessageIds: [] as string[], newMessageIds: [] as string[] };
  try {
    digestRelocation = await components.summaryHandler.relocateDigestToBottom();
  } catch (error) {
    console.warn(`摘要消息迁移失败 (${sessionId})：`, error);
    if (statusRelocation?.oldMessageId && statusRelocation.newMessageId) {
      components.statusCard.adopt(statusRelocation.oldMessageId);
      await components.channel.messages.delete(statusRelocation.newMessageId).catch(() => {});
    }
    return;
  }

  if (statusRelocation?.newMessageId) {
    sessions.setStatusCardBinding(sessionId, {
      messageId: statusRelocation.newMessageId,
    });
  }

  if (statusRelocation?.oldMessageId) {
    await components.channel.messages.delete(statusRelocation.oldMessageId).catch(() => {});
  }
  for (const messageId of digestRelocation.oldMessageIds) {
    await components.channel.messages.delete(messageId).catch(() => {});
  }
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

// 清理指定会话的所有面板状态（会话结束时调用）
export function cleanupSessionPanel(sessionId: string): void {
  sessionComponents.delete(sessionId);
  sessionStateProjections.delete(sessionId);
  sessionLastActivity.delete(sessionId);
  sessionDigests.delete(sessionId);
  lastInteractionCardTime.delete(sessionId);
  statusCardProjectionRenderer.clear(sessionId);
  stateMachine.clearSession(sessionId);
  clearPendingAnswers(sessionId);
  cleanupSessionDeliveryState(sessionId);
}

// 清理失活会话的状态投影缓存和组件
export function cleanupInactiveSessions(): void {
  const now = Date.now();
  for (const [sessionId, lastActivity] of sessionLastActivity) {
    if (now - lastActivity > SESSION_INACTIVE_TIMEOUT_MS) {
      sessionStateProjections.delete(sessionId);
      sessionLastActivity.delete(sessionId);
      sessionComponents.delete(sessionId);
      sessionDigests.delete(sessionId);
      lastInteractionCardTime.delete(sessionId);
      statusCardProjectionRenderer.clear(sessionId);
      console.log(`清理失活会话状态投影: ${sessionId}`);
    }
  }
}

// 获取性能统计
export function getPerformanceStats(): {
  discoveryLatency: ReturnType<typeof performanceTracker.getMetricStats>;
  updateLatency: ReturnType<typeof performanceTracker.getMetricStats>;
  activeSessions: number;
  projectionCount: number;
} {
  return {
    discoveryLatency: performanceTracker.getMetricStats('session_discovery_latency'),
    updateLatency: performanceTracker.getMetricStats('state_update_latency'),
    activeSessions: sessionComponents.size,
    projectionCount: sessionStateProjections.size,
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
