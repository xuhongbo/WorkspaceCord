// 面板相关的性能统计 + 周期性失活清理
// 从 panel-adapter.ts 抽出。把定时器和快照这套"后台任务"集中在一个模块，
// 便于在测试和 shutdown 路径中精准控制生命周期。

import { performanceTracker } from '../monitoring/performance-tracker.ts';
import { stateMachine } from '@workspacecord/state';
import { gateCoordinator } from '@workspacecord/state';
import { StatusCardProjectionRenderer } from '../discord/status-card-projection-renderer.ts';
import { clearPendingAnswers } from '@workspacecord/engine/output/answer-store';
import { cleanupSessionDeliveryState } from '../discord/delivery.ts';
import { clearCodexHint } from '../bot-services-helpers.ts';
import { cleanupSessionAttachments } from '../discord/attachment-inbox.ts';
import { deletePanel, getAllPanels, getPanel, getPanelCount } from './panel-state.ts';

const SESSION_INACTIVE_TIMEOUT_MS = 3_600_000; // 1 小时

export function createCleanupSessionPanel(renderer: StatusCardProjectionRenderer) {
  return function cleanupSessionPanel(sessionId: string): void {
    const panel = getPanel(sessionId);
    if (panel) panel.cleanup();
    deletePanel(sessionId);
    renderer.clear(sessionId);
    stateMachine.clearSession(sessionId);
    clearPendingAnswers(sessionId);
    cleanupSessionDeliveryState(sessionId);
    clearCodexHint(sessionId);
    cleanupSessionAttachments(sessionId).catch((e) =>
      console.warn(
        `[PanelAdapter] Failed to cleanup attachments (${sessionId}): ${(e as Error).message}`,
      ),
    );

    const activeGate = gateCoordinator.getActiveGateForSession(sessionId);
    if (activeGate) {
      gateCoordinator
        .resolveFromDiscord(activeGate.id, 'reject')
        .catch((e) =>
          console.warn(
            `[PanelAdapter] Failed to invalidate gate on cleanup (${sessionId}): ${(e as Error).message}`,
          ),
        );
    }
  };
}

export function createCleanupInactiveSessions(renderer: StatusCardProjectionRenderer) {
  return function cleanupInactiveSessions(): void {
    const now = Date.now();
    for (const [sessionId, panel] of getAllPanels()) {
      if (now - panel.getLastActivity() > SESSION_INACTIVE_TIMEOUT_MS) {
        panel.cleanup();
        deletePanel(sessionId);
        renderer.clear(sessionId);
        console.log(`清理失活会话状态投影: ${sessionId}`);
      }
    }
  };
}

export function createGetPerformanceStats() {
  return function getPerformanceStats(): {
    discoveryLatency: ReturnType<typeof performanceTracker.getMetricStats>;
    updateLatency: ReturnType<typeof performanceTracker.getMetricStats>;
    activeSessions: number;
    projectionCount: number;
  } {
    let projectionCount = 0;
    for (const [, panel] of getAllPanels()) {
      if (panel.getCachedProjection() !== null) projectionCount++;
    }
    return {
      discoveryLatency: performanceTracker.getMetricStats('session_discovery_latency'),
      updateLatency: performanceTracker.getMetricStats('state_update_latency'),
      activeSessions: getPanelCount(),
      projectionCount,
    };
  };
}

let cleanupInterval: NodeJS.Timeout | null = null;

export function startPerformanceMonitoring(onTick: () => void): void {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    onTick();
    performanceTracker.takeSnapshot();
    performanceTracker.cleanup();
  }, 60_000);
}

export function stopPerformanceMonitoring(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export function generatePerformanceReport(): string {
  return performanceTracker.generateReport();
}
