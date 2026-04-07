// 实时作战面板集成适配器
// 将新组件集成到现有 output-handler / session-executor / shell-handler

import type { SessionChannel } from './discord-types.ts';
import { StatusCardProjectionRenderer } from './discord/status-card-projection-renderer.ts';
import { SessionPanelComponent, renderDigest } from './discord/session-panel-component.ts';
import { stateMachine, type StateMachine } from '@workspacecord/state';
import { toPlatformEvent, mapPlatformEventToState } from '@workspacecord/state';
import type { ProviderEvent } from '@workspacecord/providers';
import { getSession, updateSession, getSessionPermissionSummary, setStatusCardBinding, setCurrentInteractionMessage } from '@workspacecord/engine/session-registry';
import { gateCoordinator } from '@workspacecord/state';
import type {
  PlatformEvent,
  SessionStateProjection,
  DigestItem,
  UnifiedState,
} from '@workspacecord/state';
import { performanceTracker } from './monitoring/performance-tracker.ts';
import { clearPendingAnswers } from '@workspacecord/engine/output/answer-store';
import { cleanupSessionDeliveryState } from './discord/delivery.ts';
import { clearCodexHint } from './bot-services-helpers.ts';

// 会话面板组件映射（替代原来的 5 个 Map）
const sessionPanels = new Map<string, SessionPanelComponent>();
const sessionInitializationPromises = new Map<string, Promise<void>>();

// 批量更新控制
const BATCH_UPDATE_DELAY_MS = 500;
const statusCardProjectionRenderer = new StatusCardProjectionRenderer();

// 内存控制
const SESSION_INACTIVE_TIMEOUT_MS = 3600000; // 1 小时

function getPanel(sessionId: string): SessionPanelComponent | undefined {
  return sessionPanels.get(sessionId);
}

export function getSessionProjection(sessionId: string): SessionStateProjection {
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
  const panel = getPanel(sessionId);
  if (panel) {
    panel.updateProjection(projection);
  }
}

/** @deprecated Sync removed — StateMachine is now the single source of truth for turn/humanResolved. */
function persistTurnState(sessionId: string, projection: SessionStateProjection): void {
  // Only persist for crash-recovery; StateMachine is the authoritative runtime source
  updateSession(sessionId, {
    currentTurn: projection.turn,
    humanResolved: projection.humanResolved,
  });
}

function createStatusCardProjectionContext(sessionId: string) {
  const panel = getPanel(sessionId);
  if (!panel) return undefined;
  const session = getSession(sessionId);
  return {
    statusCard: panel.statusCard,
    remoteHumanControl: session?.remoteHumanControl,
    provider: session?.provider,
    permissionsSummary: session ? getSessionPermissionSummary(session) : undefined,
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
  const session = getSession(sessionId);
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

  const existing = getPanel(sessionId);
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
    const panel = new SessionPanelComponent(sessionId, channel);
    const session = getSession(sessionId);

    await panel.initialize({
      statusCardMessageId: options.statusCardMessageId,
      initialTurn: options.initialTurn,
      phase: options.phase,
      remoteHumanControl: session?.remoteHumanControl,
      provider: session?.provider,
      permissionsSummary: session ? getSessionPermissionSummary(session) : undefined,
    });

    sessionPanels.set(sessionId, panel);

    setStatusCardBinding(sessionId, {
      messageId: panel.getMessageId() ?? options.statusCardMessageId,
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

  if (!getPanel(sessionId) && options.channel) {
    const session = getSession(sessionId);
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

  const session = getSession(sessionId);
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
  persistTurnState(sessionId, projection);

  return projection;
}

export async function handleResultEvent(
  sessionId: string,
  event: Extract<ProviderEvent, { type: 'result' }>,
  textContent: string,
  attachments: string[] = [],
): Promise<void> {
  const panel = getPanel(sessionId);
  if (!panel) return;

  const projection = ensureProjectionTurn(sessionId, 1, 'turn_bootstrap');

  const isSessionEnd = event.metadata?.sessionEnd === true;
  const source = resolveProviderSource(sessionId);
  await panel.interactionCard.hide();
  setCurrentInteractionMessage(sessionId, undefined);

  if (isSessionEnd) {
    await panel.summaryHandler.sendEndingSummary(textContent, attachments);
    await updateSessionState(sessionId, {
      type: 'session_ended',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result' },
    });
  } else if (!event.success) {
    const session = getSession(sessionId);
    const failureText =
      textContent.trim() || event.errors.join('\n').trim() || '任务失败';
    await panel.summaryHandler.sendTurnFailure(
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
    const session = getSession(sessionId);
    await panel.summaryHandler.sendTurnSummary(
      textContent,
      beforeProjection.turn,
      session?.lastInboundMessageId,
      attachments,
    );
    const projectionAfterTurn = stateMachine.advanceTurnToIdle(sessionId);
    persistTurnState(sessionId, projectionAfterTurn);
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
  const panel = getPanel(sessionId);
  if (!panel) return null;
  const session = getSession(sessionId);

  // 交互卡限流：同一会话 10 秒内最多创建 1 个
  if (!panel.checkInteractionCooldown()) {
    console.warn(`交互卡创建限流 (${sessionId}): 距上次创建仅 ${panel.getTimeSinceLastInteraction()}ms`);
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

  const messageId = await panel.interactionCard.show(sessionId, projection.turn, detail, {
    remoteHumanControl,
    provider,
  });
  gateCoordinator.bindDiscordMessage(gate.id, messageId);
  panel.recordInteractionCardTime();
  cacheProjection(sessionId, getSessionProjection(sessionId));

  updateSession(sessionId, {
    currentTurn: projection.turn,
    humanResolved: false,
    currentInteractionMessageId: messageId,
    activeHumanGateId: gate.id,
  });
  setCurrentInteractionMessage(sessionId, messageId);
  return messageId;
}

export async function relocateSessionPanelToBottom(
  sessionId: string,
  channel?: SessionChannel,
): Promise<void> {
  let panel = getPanel(sessionId);
  if (!panel && channel) {
    const session = getSession(sessionId);
    await initializeSessionPanel(sessionId, channel, {
      statusCardMessageId: session?.statusCardMessageId,
      initialTurn: session?.currentTurn || 1,
    });
    panel = getPanel(sessionId);
  }
  if (!panel) return;

  let statusRelocation:
    | {
        oldMessageId?: string;
        newMessageId: string;
      }
    | null = null;

  try {
    statusRelocation = await panel.statusCard.recreateAtBottom();
  } catch (error) {
    console.warn(`状态消息迁移失败 (${sessionId})：`, error);
    return;
  }

  let digestRelocation = { oldMessageIds: [] as string[], newMessageIds: [] as string[] };
  try {
    digestRelocation = await panel.summaryHandler.relocateDigestToBottom();
  } catch (error) {
    console.warn(`摘要消息迁移失败 (${sessionId})：`, error);
    if (statusRelocation?.oldMessageId && statusRelocation.newMessageId) {
      panel.statusCard.adopt(statusRelocation.oldMessageId);
      await panel.channel.messages.delete(statusRelocation.newMessageId).catch(() => {});
    }
    return;
  }

  if (statusRelocation?.newMessageId) {
    setStatusCardBinding(sessionId, {
      messageId: statusRelocation.newMessageId,
    });
  }

  if (statusRelocation?.oldMessageId) {
    await panel.channel.messages.delete(statusRelocation.oldMessageId).catch(() => {});
  }
  for (const messageId of digestRelocation.oldMessageIds) {
    await panel.channel.messages.delete(messageId).catch(() => {});
  }
}

export function queueDigest(sessionId: string, item: DigestItem): void {
  const panel = getPanel(sessionId);
  if (!panel) return;
  panel.queueDigest(item);
}

export function getDigestQueue(sessionId: string): DigestItem[] {
  const panel = getPanel(sessionId);
  if (!panel) return [];
  return panel.getDigestQueue();
}

export function clearDigestQueue(sessionId: string): void {
  const panel = getPanel(sessionId);
  if (panel) panel.clearDigestQueue();
}

export async function flushDigest(sessionId: string): Promise<void> {
  const panel = getPanel(sessionId);
  if (!panel) return;

  const queue = panel.getDigestQueue();
  if (queue.length === 0) return;

  await panel.summaryHandler.sendDigestSummary(renderDigest(queue));
  panel.clearDigestQueue();
}

export function mapPlatformEventTypeToUnifiedState(type: PlatformEvent['type']): UnifiedState | null {
  return mapPlatformEventToState(type);
}

export function getStateMachine(): StateMachine {
  return stateMachine;
}

// 清理指定会话的所有面板状态（会话结束时调用）
export function cleanupSessionPanel(sessionId: string): void {
  const panel = getPanel(sessionId);
  if (panel) panel.cleanup();
  sessionPanels.delete(sessionId);
  statusCardProjectionRenderer.clear(sessionId);
  stateMachine.clearSession(sessionId);
  clearPendingAnswers(sessionId);
  cleanupSessionDeliveryState(sessionId);
  clearCodexHint(sessionId);

  // Invalidate any pending human gates for this session
  const activeGate = gateCoordinator.getActiveGateForSession(sessionId);
  if (activeGate) {
    gateCoordinator.resolveFromDiscord(activeGate.id, 'reject').catch(() => {});
  }
}

// 清理失活会话的状态投影缓存和组件
export function cleanupInactiveSessions(): void {
  const now = Date.now();
  for (const [sessionId, panel] of sessionPanels) {
    if (now - panel.getLastActivity() > SESSION_INACTIVE_TIMEOUT_MS) {
      panel.cleanup();
      sessionPanels.delete(sessionId);
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
  let projectionCount = 0;
  for (const panel of sessionPanels.values()) {
    if (panel.getCachedProjection() !== null) projectionCount++;
  }
  return {
    discoveryLatency: performanceTracker.getMetricStats('session_discovery_latency'),
    updateLatency: performanceTracker.getMetricStats('state_update_latency'),
    activeSessions: sessionPanels.size,
    projectionCount,
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
