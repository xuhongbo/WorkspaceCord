// 会话注册表 — Repository 背后的单一数据源
//
// 设计:
//   - `sessionRepo` 是唯一持久化权威,PK=id,按 channelId / categoryId /
//     providerSessionId 建索引;所有查询 / 写入都通过它。
//   - 原来四个 Map(sessions / idToChannelId / sessionsByCategory /
//     providerSessionIndex)被一条 `JsonFileRepository` 替代。
//   - 运行时独有、不持久化的状态(AbortController、abortReason)仍保留独立 Map。
//   - 现存调用方习惯直接 mutate `session.X = Y`;为兼容这个模式,`updateSession`
//     / 各 setter / `debouncedSaveSession` 都会触发 `sessionRepo.reindex(id)`
//     把索引同步回来,并调度一次 debounced 写盘。

import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import {
  sanitizeName,
  resolvePath,
  JsonFileRepository,
  parseSessionPersistData,
  formatIssues,
  getDomainBus,
  SessionCreated,
  SessionEnded,
  SessionModeChanged,
} from '@workspacecord/core';
import type {
  ThreadSession,
  SessionMode,
  SessionWorkflowState,
  ProviderName,
  SchemaIssue,
} from '@workspacecord/core';
import { config } from '@workspacecord/core';
import { stateMachine } from '@workspacecord/state';
import { getOutputPort } from './output-port.ts';
import { clearBatchApprovalStore } from './output/batch-approval-store.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createDefaultWorkflowState(): SessionWorkflowState {
  return {
    status: 'idle',
    iteration: 0,
    updatedAt: Date.now(),
  };
}

// ─── Storage ──────────────────────────────────────────────────────────────────

// Repository<T> 需要 T 满足 Record<string, unknown> 约束(见 repository/types.ts)。
// ThreadSession 是显式 interface,TS 不会自动满足该约束,这里用 intersection 局部兼容。
type ThreadSessionEntity = ThreadSession & Record<string, unknown>;

const sessionRepo = new JsonFileRepository<ThreadSessionEntity>({
  filename: 'sessions.json',
  idField: 'id',
  indexes: [
    { field: 'channelId' },
    { field: 'categoryId' },
    { field: 'providerSessionId' },
  ],
  serialize: (session) => {
    // 写盘时去掉 SessionRuntimeFields(当前只有 isGenerating);
    // 加载时 parse 会补回默认 false,因此 JSON 里不会出现这一字段。
    const { isGenerating: _ignored, ...persistent } = session as ThreadSessionEntity & {
      isGenerating: boolean;
    };
    void _ignored;
    return persistent;
  },
  parse: (raw, idx) => {
    const issues: SchemaIssue[] = [];
    const parsed = parseSessionPersistData(raw, idx, issues);
    if (!parsed) {
      if (issues.length > 0) {
        console.warn(
          `[session-manager] Dropped invalid session record at index ${idx}:\n${formatIssues(issues)}`,
        );
      }
      return undefined;
    }
    // hydrate 到 ThreadSession:补齐默认值,强制清零运行时字段
    return {
      ...parsed,
      provider: (parsed.provider ?? 'claude') as ProviderName,
      verbose: parsed.verbose ?? false,
      mode: parsed.mode ?? 'auto',
      subagentDepth: parsed.subagentDepth ?? 0,
      type: parsed.type ?? 'persistent',
      workflowState: parsed.workflowState ?? createDefaultWorkflowState(),
      currentTurn: parsed.currentTurn ?? 0,
      humanResolved: parsed.humanResolved ?? false,
      discoverySource: parsed.discoverySource ?? 'discord',
      isGenerating: false,
    } as ThreadSessionEntity;
  },
  debounceMs: 1000,
});

// Session 运行时状态(不持久化)
const sessionControllers = new Map<string, AbortController>();
const sessionAbortReasons = new Map<string, 'user' | 'watchdog'>();

let initialized = false;

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadSessions(): Promise<void> {
  if (initialized) return;
  await sessionRepo.init();
  initialized = true;

  const sessions = sessionRepo.getAll();
  // P2b:把 turn/humanResolved 灌入 StateMachine,使其成为 in-memory 权威源。
  for (const s of sessions) {
    if ((s.currentTurn ?? 0) > 0 || (s.humanResolved ?? false)) {
      stateMachine.transition(
        s.id,
        'session_restored',
        {},
        {
          turn: s.currentTurn ?? 0,
          humanResolved: s.humanResolved ?? false,
          updatedAt: Date.now(),
        },
      );
    }
  }

  console.log(`[session-manager] Restored ${sessions.length} session(s)`);
}

/**
 * 直接 mutate session 对象后,调用该函数同步索引并调度一次写盘。
 * 不知道具体哪个 session 变动时,会对所有 session reindex(n 很小,代价低)。
 */
function scheduleResyncAndWrite(sessionId?: string): void {
  if (sessionId) {
    sessionRepo.reindex(sessionId);
    return;
  }
  for (const s of sessionRepo.getAll()) sessionRepo.reindex(s.id);
}

// ─── Create / CRUD ────────────────────────────────────────────────────────────

export interface CreateSessionParams {
  channelId: string;
  categoryId: string;
  projectName: string;
  agentLabel: string;
  provider: ProviderName;
  directory: string;
  providerSessionId?: string;
  model?: string;
  type: 'persistent' | 'subagent';
  parentChannelId?: string;
  subagentDepth?: number;
  mode?: SessionMode;
  claudePermissionMode?: 'bypass' | 'normal';
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexApprovalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  codexBypass?: boolean;
  codexNetworkAccessEnabled?: boolean;
  codexWebSearchMode?: 'disabled' | 'cached' | 'live';
  discoverySource?: 'discord' | 'claude-hook' | 'codex-log' | 'sync';
  remoteHumanControl?: boolean;
}

export async function createSession(params: CreateSessionParams): Promise<ThreadSession> {
  const {
    channelId,
    categoryId,
    projectName,
    agentLabel,
    provider,
    providerSessionId,
    model,
    type,
    parentChannelId,
    subagentDepth = 0,
    mode = config.defaultMode,
    claudePermissionMode,
    codexSandboxMode,
    codexApprovalPolicy,
    codexBypass,
    codexNetworkAccessEnabled,
    codexWebSearchMode,
    discoverySource = 'discord',
    remoteHumanControl,
  } = params;

  const resolvedDir = resolvePath(params.directory);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  // channelId 唯一性:走索引的 O(1) 检查
  if (sessionRepo.find({ where: { channelId }, limit: 1 }).length > 0) {
    throw new Error(`Session for channelId "${channelId}" already exists`);
  }

  // 从 agentLabel 派生唯一内部 ID(autoincrement 后缀防冲突)
  const baseId = sanitizeName(agentLabel);
  let id = baseId;
  let suffix = 1;
  while (sessionRepo.get(id)) {
    suffix++;
    const suffixStr = `-${suffix}`;
    id = baseId.slice(0, 50 - suffixStr.length) + suffixStr;
  }

  const session: ThreadSession = {
    id,
    channelId,
    categoryId,
    projectName,
    agentLabel,
    provider,
    providerSessionId,
    model,
    type,
    parentChannelId,
    subagentDepth,
    directory: resolvedDir,
    mode,
    agentPersona: undefined,
    verbose: false,
    claudePermissionMode,
    codexSandboxMode,
    codexApprovalPolicy,
    codexBypass,
    codexNetworkAccessEnabled,
    codexWebSearchMode,
    monitorGoal: undefined,
    monitorProviderSessionId: undefined,
    workflowState: createDefaultWorkflowState(),
    isGenerating: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    totalCost: 0,
    currentTurn: 0,
    humanResolved: false,
    currentInteractionMessageId: undefined,
    statusCardMessageId: undefined,
    lastInboundMessageId: undefined,
    discoverySource,
    remoteHumanControl,
  };

  await sessionRepo.save(session as ThreadSessionEntity);
  await sessionRepo.flush(); // createSession 立即落盘

  getDomainBus().emit(
    SessionCreated,
    {
      sessionId: session.id,
      channelId: session.channelId,
      categoryId: session.categoryId,
      provider: session.provider,
      type: session.type,
      mode: session.mode,
      discoverySource: session.discoverySource ?? 'discord',
    },
    'session-registry',
  );

  return session;
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

export function getSession(id: string): ThreadSession | undefined {
  return sessionRepo.get(id);
}

export function getSessionByChannel(channelId: string): ThreadSession | undefined {
  return sessionRepo.find({ where: { channelId }, limit: 1 })[0];
}

/** Backward-compat alias */
export const getSessionByThread = getSessionByChannel;

export function getSessionByCodexId(codexSessionId: string): ThreadSession | undefined {
  return getSessionByProviderSession('codex', codexSessionId);
}

export function getSessionByProviderSession(
  provider: ProviderName,
  providerSessionId: string,
): ThreadSession | undefined {
  if (!providerSessionId) return undefined;
  const candidates = sessionRepo.find({ where: { providerSessionId } });
  return candidates.find((s) => s.provider === provider);
}

export function getSessionsByCategory(categoryId: string): ThreadSession[] {
  return sessionRepo.find({ where: { categoryId } });
}

export function getAllSessions(): ThreadSession[] {
  return sessionRepo.getAll();
}

export function findCodexSessionForMonitor(
  providerSessionId: string | undefined,
  cwd: string | undefined,
): ThreadSession | undefined {
  if (providerSessionId) {
    const byProviderId = getSessionByProviderSession('codex', providerSessionId);
    if (byProviderId) return byProviderId;
  }

  if (!cwd) return undefined;
  const normalizedCwd = resolvePath(cwd);
  let matched: ThreadSession | undefined;
  let matchedLen = -1;

  for (const session of sessionRepo.getAll()) {
    if (session.provider !== 'codex') continue;
    const sessionDir = resolvePath(session.directory);
    if (normalizedCwd !== sessionDir && !normalizedCwd.startsWith(`${sessionDir}/`)) continue;
    if (sessionDir.length > matchedLen) {
      matched = session;
      matchedLen = sessionDir.length;
    }
  }

  return matched;
}

function stripCodexMonitorPrefix(sessionId: string): string {
  return sessionId.startsWith('codex:') ? sessionId.slice('codex:'.length) : sessionId;
}

export function findCodexSessionByProviderSessionId(providerSessionId: string): ThreadSession | undefined {
  const normalized = stripCodexMonitorPrefix(providerSessionId);
  const byNormalized = getSessionByProviderSession('codex', normalized);
  if (byNormalized) return byNormalized;
  if (normalized !== providerSessionId) {
    return getSessionByProviderSession('codex', providerSessionId);
  }
  return undefined;
}

export function findCodexSessionByCwd(cwd: string): ThreadSession | undefined {
  const normalizedCwd = resolvePath(cwd);
  let best: ThreadSession | undefined;
  let bestLen = -1;

  for (const session of sessionRepo.getAll()) {
    if (session.provider !== 'codex') continue;
    const dir = resolvePath(session.directory);
    const isMatch = normalizedCwd === dir || normalizedCwd.startsWith(`${dir}${sep}`);
    if (!isMatch) continue;
    if (dir.length > bestLen) {
      best = session;
      bestLen = dir.length;
    }
  }

  return best;
}

export function resolveCodexSessionFromMonitor(
  monitorSessionId: string,
  cwd?: string,
): ThreadSession | undefined {
  const byProviderSessionId = findCodexSessionByProviderSessionId(monitorSessionId);
  if (byProviderSessionId) return byProviderSessionId;
  if (cwd) return findCodexSessionByCwd(cwd);
  return undefined;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export function updateSession(
  sessionId: string,
  patch: Partial<ThreadSession>,
): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  Object.assign(session, patch);
  // patch 可能改变索引字段(例如 providerSessionId) → 走 reindex 确保索引一致,并调度写盘
  sessionRepo.reindex(sessionId);
}

export async function updateSessionPermissions(
  sessionId: string,
  patch: Partial<
    Pick<
      ThreadSession,
      | 'claudePermissionMode'
      | 'codexSandboxMode'
      | 'codexApprovalPolicy'
      | 'codexBypass'
      | 'codexNetworkAccessEnabled'
      | 'codexWebSearchMode'
    >
  >,
): Promise<void> {
  const session = sessionRepo.get(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  Object.assign(session, patch);
  session.lastActivity = Date.now();
  sessionRepo.reindex(sessionId); // 更新这些字段通常不触发索引变化,但统一走 reindex 保证落盘
  await sessionRepo.flush();
}

// ─── Permission resolution (delegated to session-permissions.ts) ─────────────

export {
  resolveEffectiveClaudePermissionMode,
  resolveEffectiveCodexOptions,
  getSessionPermissionSummary,
  getSessionPermissionDetails,
} from './session/permissions.ts';

// ─── Bindings ─────────────────────────────────────────────────────────────────

export function setStatusCardBinding(
  sessionId: string,
  binding: { messageId?: string },
): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.statusCardMessageId = binding.messageId;
  sessionRepo.reindex(sessionId);
}

export function setCurrentInteractionMessage(
  sessionId: string,
  messageId: string | undefined,
): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.currentInteractionMessageId = messageId;
  sessionRepo.reindex(sessionId);
}

// ─── End session ──────────────────────────────────────────────────────────────

export async function endSession(id: string): Promise<void> {
  const session = sessionRepo.get(id);
  if (!session) return; // Idempotent: already ended

  const controller = sessionControllers.get(session.id);
  if (controller && session.isGenerating) {
    controller.abort();
  }
  sessionControllers.delete(session.id);
  sessionAbortReasons.delete(session.id);
  // Drain any deferred batch approvals so SDK turns don't leak on end/abort.
  clearBatchApprovalStore(session.id);

  // 快照 channelId / categoryId 在 delete 前,避免事件 payload 引用到被移除的记录
  const channelId = session.channelId;
  const categoryId = session.categoryId;

  await sessionRepo.delete(id);
  await sessionRepo.flush();

  getOutputPort().cleanupPanel(session.id);

  getDomainBus().emit(
    SessionEnded,
    { sessionId: id, channelId, categoryId },
    'session-registry',
  );
}

// ─── State management ─────────────────────────────────────────────────────────

export function setMode(sessionId: string, mode: SessionMode): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  const previousMode = session.mode;
  session.mode = mode;
  if (mode === 'monitor') {
    session.monitorProviderSessionId = undefined;
  }
  session.workflowState = createDefaultWorkflowState();
  sessionRepo.reindex(sessionId);
  if (previousMode !== mode) {
    getDomainBus().emit(
      SessionModeChanged,
      { sessionId, previousMode, nextMode: mode },
      'session-registry',
    );
  }
}

export function setVerbose(sessionId: string, verbose: boolean): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.verbose = verbose;
  sessionRepo.reindex(sessionId);
}

export function setModel(sessionId: string, model: string): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.model = model;
  sessionRepo.reindex(sessionId);
}

export function setAgentPersona(sessionId: string, persona: string | undefined): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.agentPersona = persona;
  sessionRepo.reindex(sessionId);
}

export function setMonitorGoal(sessionId: string, goal: string | undefined): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.monitorGoal = goal;
  if (!goal) {
    session.monitorProviderSessionId = undefined;
  }
  session.workflowState = createDefaultWorkflowState();
  sessionRepo.reindex(sessionId);
}

export function updateWorkflowState(
  sessionId: string,
  patch: Partial<SessionWorkflowState> | ((current: SessionWorkflowState) => SessionWorkflowState),
): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;

  const next =
    typeof patch === 'function'
      ? patch(session.workflowState)
      : { ...session.workflowState, ...patch };

  session.workflowState = {
    ...next,
    updatedAt: Date.now(),
  };
  sessionRepo.reindex(sessionId);
}

export function resetWorkflowState(sessionId: string): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.workflowState = createDefaultWorkflowState();
  sessionRepo.reindex(sessionId);
}

// ─── Abort management ─────────────────────────────────────────────────────────

export function abortSession(sessionId: string): boolean {
  return abortSessionWithReason(sessionId, 'user');
}

export function abortSessionWithReason(sessionId: string, reason: 'user' | 'watchdog'): boolean {
  const session = sessionRepo.get(sessionId);
  if (!session) return false;

  const controller = sessionControllers.get(session.id);
  sessionAbortReasons.set(session.id, reason);

  if (controller) {
    controller.abort();
    // 无论 isGenerating 是否为 true,一旦中止即移除引用,防止悬挂的 controller
    sessionControllers.delete(session.id);
  }

  if (session.isGenerating) {
    session.isGenerating = false;
    sessionRepo.reindex(sessionId);
    return true;
  }

  return !!controller;
}

export function consumeAbortReason(sessionId: string): 'user' | 'watchdog' | undefined {
  const session = sessionRepo.get(sessionId);
  if (!session) return undefined;
  const reason = sessionAbortReasons.get(session.id);
  sessionAbortReasons.delete(session.id);
  return reason;
}

// ─── Abort controller access (for executor) ───────────────────────────────────

export function getSessionController(sessionId: string): AbortController | undefined {
  const session = sessionRepo.get(sessionId);
  if (!session) return undefined;
  return sessionControllers.get(session.id);
}

export function setSessionController(sessionId: string, controller: AbortController): void {
  sessionControllers.set(sessionId, controller);
}

export function clearSessionController(sessionId: string): void {
  sessionControllers.delete(sessionId);
}

export function clearSessionAbortReason(sessionId: string): void {
  sessionAbortReasons.delete(sessionId);
}

export function markSessionGenerating(sessionId: string, generating: boolean): void {
  const session = sessionRepo.get(sessionId);
  if (!session) return;
  session.isGenerating = generating;
  session.lastActivity = Date.now();
  sessionRepo.reindex(sessionId);
  if (!generating) {
    void sessionRepo.flush();
  }
}

export function saveSessionImmediate(): Promise<void> {
  scheduleResyncAndWrite();
  return sessionRepo.flush();
}

export function debouncedSaveSession(): void {
  scheduleResyncAndWrite();
}

// ─── Testing utilities ────────────────────────────────────────────────────────

/** 测试工具:清空仓储 + 运行时状态。仅供 vitest 使用。 */
export async function _resetSessionRegistryForTest(): Promise<void> {
  await sessionRepo.clear();
  sessionControllers.clear();
  sessionAbortReasons.clear();
  initialized = false;
}
