// 实时作战面板集成适配器（facade）
// 历史上承载了 500+ 行逻辑；此处作为薄外观，具体实现下沉到 ./panel/ 子模块：
//   - panel/panel-state.ts        — 共享会话面板 Map
//   - panel/panel-relocation.ts   — 面板重定位到频道底部
//   - panel/panel-performance.ts  — 性能监控与失活清理

import type { SessionChannel } from './discord-types.ts';
import { StatusCardProjectionRenderer } from './discord/status-card-projection-renderer.ts';
import { SessionPanelComponent, renderDigest } from './discord/session-panel-component.ts';
import { stateMachine, type StateMachine } from '@workspacecord/state';
import { toPlatformEvent, mapPlatformEventToState } from '@workspacecord/state';
import type { ProviderEvent } from '@workspacecord/providers';
import {
  getSession,
  updateSession,
  getSessionPermissionSummary,
  setStatusCardBinding,
  setCurrentInteractionMessage,
} from '@workspacecord/engine/session-registry';
import { gateCoordinator } from '@workspacecord/state';
import type {
  PlatformEvent,
  SessionStateProjection,
  DigestItem,
  UnifiedState,
} from '@workspacecord/state';
import { performanceTracker } from './monitoring/performance-tracker.ts';
import {
  getPanel,
  setPanel,
  getInitializationPromise,
  setInitializationPromise,
  deleteInitializationPromise,
} from './panel/panel-state.ts';
import { relocateSessionPanelToBottom as doRelocate } from './panel/panel-relocation.ts';
import {
  createCleanupSessionPanel,
  createCleanupInactiveSessions,
  createGetPerformanceStats,
  startPerformanceMonitoring as startPerfMonitoring,
  stopPerformanceMonitoring,
  generatePerformanceReport,
} from './panel/panel-performance.ts';

// 批量更新控制
const BATCH_UPDATE_DELAY_MS = 500;
const statusCardProjectionRenderer = new StatusCardProjectionRenderer();

// ─── Projection helpers ──────────────────────────────────────────────────────

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
  if (panel) panel.updateProjection(projection);
}

/**
 * Persister 回调注册:P2 后 StateMachine 是 turn/humanResolved 的 in-memory 权威源,
 * 这里只负责把变更写回 ThreadSession(用于崩溃恢复)。
 * 启动时注册一次,避免每次 transition 都要 panel-adapter 手动 persist。
 */
stateMachine.registerTurnStatePersister((sessionId, projection) => {
  updateSession(sessionId, {
    currentTurn: projection.turn,
    humanResolved: projection.humanResolved,
  });
});

function createStatusCardProjectionContext(sessionId: string) {
  const panel = getPanel(sessionId);
  if (!panel) return undefined;
  const session = getSession(sessionId);
  return {
    statusCard: panel.statusCard,
    remoteHumanControl: session?.remoteHumanControl,
    provider: session?.provider,
    permissionsSummary: session ? getSessionPermissionSummary(session) : undefined,
    verbose: session?.verbose,
    monitorGoal: session?.monitorGoal,
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

// ─── Panel lifecycle ─────────────────────────────────────────────────────────

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

  if (getPanel(sessionId)) {
    performanceTracker.endSessionDiscovery(sessionId, { cached: true });
    return;
  }

  const pendingInitialization = getInitializationPromise(sessionId);
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

    setPanel(sessionId, panel);

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

  setInitializationPromise(sessionId, initialization);
  try {
    await initialization;
    performanceTracker.endSessionDiscovery(sessionId, { cached: false });
  } finally {
    deleteInitializationPromise(sessionId);
  }
}

export async function registerExistingStatusCard(
  sessionId: string,
  channel: SessionChannel,
  statusCardMessageId: string,
): Promise<void> {
  await initializeSessionPanel(sessionId, channel, { statusCardMessageId });
}

// ─── State updates ───────────────────────────────────────────────────────────

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

  const previousProjection = getSessionProjection(sessionId);
  const projection = stateMachine.applyPlatformEvent(platformEvent);
  cacheProjection(sessionId, projection);

  const stateChanged =
    projection.state !== previousProjection.state ||
    projection.turn !== previousProjection.turn ||
    projection.phase !== previousProjection.phase;

  if (stateChanged) {
    await scheduleProjectionRender(sessionId, projection, updateKey);
  } else {
    performanceTracker.endStateUpdate(updateKey, { skipped: true });
  }
  // P2:StateMachine 内部已通过 persister 回调同步 turn/humanResolved,此处不再手动 persist

  return projection;
}

// ─── Result dispatch ─────────────────────────────────────────────────────────

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
    const failureText = textContent.trim() || event.errors.join('\n').trim() || '任务失败';
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
    // P2:StateMachine persister 已负责同步 turn/humanResolved
    await renderProjectionToStatusCard(sessionId, projectionAfterTurn);
    cacheProjection(sessionId, projectionAfterTurn);
  }
}

// ─── Awaiting human ──────────────────────────────────────────────────────────

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

  if (!panel.checkInteractionCooldown()) {
    console.warn(
      `交互卡创建限流 (${sessionId}): 距上次创建仅 ${panel.getTimeSinceLastInteraction()}ms`,
    );
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

// ─── Relocation ──────────────────────────────────────────────────────────────

export async function relocateSessionPanelToBottom(
  sessionId: string,
  channel?: SessionChannel,
): Promise<void> {
  await doRelocate(sessionId, channel, (sid, ch, options) =>
    initializeSessionPanel(sid, ch, options as Parameters<typeof initializeSessionPanel>[2]),
  );
}

// ─── Digest queue ────────────────────────────────────────────────────────────

export function queueDigest(sessionId: string, item: DigestItem): void {
  getPanel(sessionId)?.queueDigest(item);
}

export function getDigestQueue(sessionId: string): DigestItem[] {
  return getPanel(sessionId)?.getDigestQueue() ?? [];
}

export function clearDigestQueue(sessionId: string): void {
  getPanel(sessionId)?.clearDigestQueue();
}

export async function flushDigest(sessionId: string): Promise<void> {
  const panel = getPanel(sessionId);
  if (!panel) return;

  const queue = panel.getDigestQueue();
  if (queue.length === 0) return;

  await panel.summaryHandler.sendDigestSummary(renderDigest(queue));
  panel.clearDigestQueue();
}

// ─── State-machine re-exports ────────────────────────────────────────────────

export function mapPlatformEventTypeToUnifiedState(
  type: PlatformEvent['type'],
): UnifiedState | null {
  return mapPlatformEventToState(type);
}

export function getStateMachine(): StateMachine {
  return stateMachine;
}

// ─── Cleanup & performance monitoring ────────────────────────────────────────

export const cleanupSessionPanel = createCleanupSessionPanel(statusCardProjectionRenderer);
export const cleanupInactiveSessions = createCleanupInactiveSessions(statusCardProjectionRenderer);
export const getPerformanceStats = createGetPerformanceStats();

export function startPerformanceMonitoring(): void {
  startPerfMonitoring(() => cleanupInactiveSessions());
}

export { stopPerformanceMonitoring, generatePerformanceReport };
