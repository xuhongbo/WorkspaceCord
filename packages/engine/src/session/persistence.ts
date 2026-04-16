// Session persistence — P4 重构后走 Repository 层(JSON 实现)
// 旧的 saveAllSessions / debouncedSave 仍保留作为兼容入口,内部直接调用 Repository。

import { JsonFileRepository, parseSessionPersistData, formatIssues } from '@workspacecord/core';
import type { SchemaIssue } from '@workspacecord/core';
import type { ThreadSession, SessionPersistData } from '@workspacecord/core';

// Repository 单例 — 这里 debounceMs=0,因为外层 session-registry 已经有 1s debounce。
// 避免双重 debounce(1s+1s=2s 延迟)让测试和关键操作产生误解。
const sessionRepo = new JsonFileRepository<SessionPersistData>({
  filename: 'sessions.json',
  idField: 'id',
  parse: (raw, i) => {
    const issues: SchemaIssue[] = [];
    const parsed = parseSessionPersistData(raw, i, issues);
    if (issues.length > 0 && !parsed) {
      console.warn(
        `[session-manager] Dropped invalid session record at index ${i}:\n${formatIssues(issues)}`,
      );
    }
    return parsed;
  },
  debounceMs: 0,
});

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await sessionRepo.init();
  initialized = true;
}

/** Read persisted sessions from disk. */
export async function loadPersistedSessions(): Promise<SessionPersistData[]> {
  await ensureInit();
  return sessionRepo.getAll();
}

function toPersistData(s: ThreadSession): SessionPersistData {
  return {
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
  };
}

/** Save all sessions to disk (Repository 内部已 debounce,此处只同步 snapshot)。 */
export function saveAllSessions(sessions: Map<string, ThreadSession>): Promise<void> {
  const snapshot: SessionPersistData[] = [];
  for (const [, s] of sessions) snapshot.push(toPersistData(s));
  // 通过 saveMany + clear 前缀的差分,不过简单起见我们直接 clear + saveMany
  // 避免在删除会话后 sessions Map 已少了一条但 repo 还留着旧记录。
  return (async () => {
    await ensureInit();
    // 收集 repo 中不再出现的 id 并逐个删除
    const keepIds = new Set(snapshot.map((s) => s.id));
    for (const existing of sessionRepo.getAll()) {
      if (!keepIds.has(existing.id)) {
        await sessionRepo.delete(existing.id);
      }
    }
    await sessionRepo.saveMany(snapshot);
  })();
}

let saveTimer: NodeJS.Timeout | null = null;

/** 延迟批量保存(1 秒内合并) — 向后兼容入口。 */
export function debouncedSave(sessions: Map<string, ThreadSession>): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveAllSessions(sessions).catch((err: unknown) => {
      console.error(`[session-manager] Failed to persist sessions: ${(err as Error).message}`);
    });
  }, 1000);
  saveTimer.unref?.();
}

/** 立即保存(关键操作使用)。 */
export function saveImmediate(sessions: Map<string, ThreadSession>): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveAllSessions(sessions).then(() => sessionRepo.flush());
}

/** 测试/工具入口:直接拿到底层 Repository。 */
export function getSessionRepository(): JsonFileRepository<SessionPersistData> {
  return sessionRepo;
}
