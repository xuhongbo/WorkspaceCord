// Session persistence — extracted from session-registry.ts
// Handles reading/writing session data to disk via Store

import { Store } from '@workspacecord/core';
import type { ThreadSession, SessionPersistData } from '@workspacecord/core';

const sessionStore = new Store<SessionPersistData[]>('sessions.json');

let saveQueue: Promise<void> = Promise.resolve();
let saveTimer: NodeJS.Timeout | null = null;

/** Read persisted sessions from disk (raw data, no index building). */
export async function loadPersistedSessions(): Promise<SessionPersistData[]> {
  const data = await sessionStore.read();
  return data ?? [];
}

function serializeSessions(sessions: Map<string, ThreadSession>): SessionPersistData[] {
  const data: SessionPersistData[] = [];
  for (const [, s] of sessions) {
    data.push({
      id: s.id,
      channelId: s.channelId,
      categoryId: s.categoryId,
      projectName: s.projectName,
      agentLabel: s.agentLabel,
      provider: s.provider,
      providerSessionId: s.providerSessionId,
      model: s.model,
      type: s.type,
      parentChannelId: s.parentChannelId,
      subagentDepth: s.subagentDepth,
      directory: s.directory,
      mode: s.mode,
      agentPersona: s.agentPersona,
      verbose: s.verbose || false,
      claudePermissionMode: s.claudePermissionMode,
      codexSandboxMode: s.codexSandboxMode,
      codexApprovalPolicy: s.codexApprovalPolicy,
      codexBypass: s.codexBypass,
      codexNetworkAccessEnabled: s.codexNetworkAccessEnabled,
      codexWebSearchMode: s.codexWebSearchMode,
      monitorGoal: s.monitorGoal,
      monitorProviderSessionId: s.monitorProviderSessionId,
      workflowState: s.workflowState,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      messageCount: s.messageCount,
      totalCost: s.totalCost,
      currentTurn: s.currentTurn,
      humanResolved: s.humanResolved,
      currentInteractionMessageId: s.currentInteractionMessageId,
      statusCardMessageId: s.statusCardMessageId,
      lastInboundMessageId: s.lastInboundMessageId,
      discoverySource: s.discoverySource,
      lastObservedState: s.lastObservedState,
      lastObservedEventKey: s.lastObservedEventKey,
      lastObservedAt: s.lastObservedAt,
      lastObservedCwd: s.lastObservedCwd,
      remoteHumanControl: s.remoteHumanControl,
      activeHumanGateId: s.activeHumanGateId,
    });
  }
  return data;
}

async function persistNow(sessions: Map<string, ThreadSession>): Promise<void> {
  const data = serializeSessions(sessions);
  await sessionStore.write(data);
}

/** Save all sessions to disk (queued to avoid concurrent writes). */
export function saveAllSessions(sessions: Map<string, ThreadSession>): Promise<void> {
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        await persistNow(sessions);
      } catch (err: unknown) {
        console.error(`[session-manager] Failed to persist sessions: ${(err as Error).message}`);
      }
    });
  return saveQueue;
}

/** 延迟批量保存（1秒内的多次调用会合并） */
export function debouncedSave(sessions: Map<string, ThreadSession>): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAllSessions(sessions);
  }, 1000);
}

/** 立即保存（用于关键操作） */
export function saveImmediate(sessions: Map<string, ThreadSession>): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveAllSessions(sessions);
}
