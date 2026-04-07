// 会话注册表 — 纯存储、CRUD、查找索引
// 从 thread-manager.ts 提取，职责单一化

import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { Store } from './persistence.ts';
import { sanitizeName, resolvePath } from './utils.ts';
import type {
  ThreadSession,
  SessionPersistData,
  SessionMode,
  SessionWorkflowState,
  ProviderName,
} from './types.ts';
import { config } from './config.ts';
import { cleanupSessionPanel } from './panel-adapter.ts';

// ─── Storage ──────────────────────────────────────────────────────────────────

const sessionStore = new Store<SessionPersistData[]>('sessions.json');

// channelId (the session's own Discord channel or thread ID) → ThreadSession
const sessions = new Map<string, ThreadSession>();

// internal session id → channelId
const idToChannelId = new Map<string, string>();

// categoryId → Set<channelId> (索引，用于快速查找)
const sessionsByCategory = new Map<string, Set<string>>();

// providerSessionId → channelId (二级索引，用于 O(1) provider session 查找)
const providerSessionIndex = new Map<string, string>();

// Session 运行时状态（不持久化）
const sessionControllers = new Map<string, AbortController>();
const sessionAbortReasons = new Map<string, 'user' | 'watchdog'>();

let saveQueue: Promise<void> = Promise.resolve();
let saveTimer: NodeJS.Timeout | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createDefaultWorkflowState(): SessionWorkflowState {
  return {
    status: 'idle',
    iteration: 0,
    updatedAt: Date.now(),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export async function loadSessions(): Promise<void> {
  const data = await sessionStore.read();
  if (!data) return;

  let cleaned = false;

  for (const s of data) {
    if (!s.categoryId) {
      cleaned = true;
      console.warn(`Skipping invalid persisted session "${s.id}" (missing categoryId).`);
      continue;
    }
    if (!s.channelId) {
      cleaned = true;
      console.warn(`Skipping invalid persisted session "${s.id}" (missing channelId).`);
      continue;
    }
    if (sessions.has(s.channelId)) {
      cleaned = true;
      console.warn(
        `Skipping duplicate persisted session "${s.id}" (channelId ${s.channelId} already loaded).`,
      );
      continue;
    }

    const provider: ProviderName = s.provider ?? 'claude';

    sessions.set(s.channelId, {
      ...s,
      provider,
      verbose: s.verbose ?? false,
      mode: s.mode ?? 'auto',
      subagentDepth: s.subagentDepth ?? 0,
      type: s.type ?? 'persistent',
      codexSandboxMode: s.codexSandboxMode,
      codexApprovalPolicy: s.codexApprovalPolicy,
      codexBypass: s.codexBypass,
      codexNetworkAccessEnabled: s.codexNetworkAccessEnabled,
      codexWebSearchMode: s.codexWebSearchMode,
      workflowState: s.workflowState ?? createDefaultWorkflowState(),
      currentTurn: s.currentTurn ?? 0,
      humanResolved: s.humanResolved ?? false,
      currentInteractionMessageId: s.currentInteractionMessageId,
      statusCardMessageId: s.statusCardMessageId,
      lastInboundMessageId: s.lastInboundMessageId,
      discoverySource: s.discoverySource ?? 'discord',
      lastObservedState: s.lastObservedState,
      lastObservedEventKey: s.lastObservedEventKey,
      lastObservedAt: s.lastObservedAt,
      lastObservedCwd: s.lastObservedCwd,
      remoteHumanControl: s.remoteHumanControl,
      activeHumanGateId: s.activeHumanGateId,
      isGenerating: false,
    });
    idToChannelId.set(s.id, s.channelId);

    // 维护 provider session 索引
    if (s.providerSessionId) {
      providerSessionIndex.set(s.providerSessionId, s.channelId);
    }

    // 维护 category 索引
    if (!sessionsByCategory.has(s.categoryId)) {
      sessionsByCategory.set(s.categoryId, new Set());
    }
    sessionsByCategory.get(s.categoryId)!.add(s.channelId);
  }

  if (cleaned) {
    await saveSessions();
  }

  console.log(`[session-manager] Restored ${sessions.size} session(s)`);
}

async function persistSessionsNow(): Promise<void> {
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
  await sessionStore.write(data);
}

function saveSessions(): Promise<void> {
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        await persistSessionsNow();
      } catch (err: unknown) {
        console.error(`[session-manager] Failed to persist sessions: ${(err as Error).message}`);
      }
    });
  return saveQueue;
}

/** 延迟批量保存（1秒内的多次调用会合并） */
function debouncedSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSessions();
  }, 1000);
}

/** 立即保存（用于关键操作） */
function saveSessionsImmediate(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return saveSessions();
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

  if (sessions.has(channelId)) {
    throw new Error(`Session for channelId "${channelId}" already exists`);
  }

  // Derive a unique internal ID from the agentLabel (auto-deduplicate)
  let id = sanitizeName(agentLabel);
  let suffix = 1;
  while (idToChannelId.has(id)) {
    suffix++;
    id = sanitizeName(`${agentLabel}-${suffix}`);
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

  sessions.set(channelId, session);
  idToChannelId.set(id, channelId);
  if (providerSessionId) {
    providerSessionIndex.set(providerSessionId, channelId);
  }

  if (!sessionsByCategory.has(categoryId)) {
    sessionsByCategory.set(categoryId, new Set());
  }
  sessionsByCategory.get(categoryId)!.add(channelId);

  await saveSessionsImmediate();

  return session;
}

// ─── Lookups ──────────────────────────────────────────────────────────────────

export function getSession(id: string): ThreadSession | undefined {
  const channelId = idToChannelId.get(id);
  return channelId ? sessions.get(channelId) : undefined;
}

export function getSessionByChannel(channelId: string): ThreadSession | undefined {
  return sessions.get(channelId);
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
  const channelId = providerSessionIndex.get(providerSessionId);
  if (channelId) {
    const session = sessions.get(channelId);
    if (session && session.provider === provider) return session;
  }
  return undefined;
}

export function getSessionsByCategory(categoryId: string): ThreadSession[] {
  const channelIds = sessionsByCategory.get(categoryId);
  if (!channelIds) return [];

  const result: ThreadSession[] = [];
  for (const channelId of channelIds) {
    const session = sessions.get(channelId);
    if (session) result.push(session);
  }
  return result;
}

export function getAllSessions(): ThreadSession[] {
  return Array.from(sessions.values());
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

  for (const session of sessions.values()) {
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
  // Try O(1) index lookup first
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

  for (const session of sessions.values()) {
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
  const session = getSession(sessionId);
  if (!session) return;
  // Update providerSessionId index if changed
  if (patch.providerSessionId !== undefined && patch.providerSessionId !== session.providerSessionId) {
    if (session.providerSessionId) providerSessionIndex.delete(session.providerSessionId);
    if (patch.providerSessionId) providerSessionIndex.set(patch.providerSessionId, session.channelId);
  }
  Object.assign(session, patch);
  debouncedSave();
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
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  Object.assign(session, patch);
  session.lastActivity = Date.now();
  await saveSessionsImmediate();
}

// ─── Permission resolution ────────────────────────────────────────────────────

export function resolveEffectiveClaudePermissionMode(session: ThreadSession): 'bypass' | 'normal' {
  return session.mode === 'auto' ? 'bypass' : (session.claudePermissionMode ?? config.claudePermissionMode);
}

export function resolveEffectiveCodexOptions(session: ThreadSession): {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  networkAccessEnabled: boolean;
  webSearchMode: 'disabled' | 'cached' | 'live';
  bypass: boolean;
} {
  const bypass = session.codexBypass === true;
  if (bypass) {
    return {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      webSearchMode: 'live',
      bypass: true,
    };
  }

  return {
    sandboxMode: session.codexSandboxMode ?? config.codexSandboxMode,
    approvalPolicy:
      session.mode === 'auto'
        ? 'never'
        : (session.codexApprovalPolicy ?? config.codexApprovalPolicy),
    networkAccessEnabled: session.codexNetworkAccessEnabled ?? config.codexNetworkAccessEnabled,
    webSearchMode: session.codexWebSearchMode ?? config.codexWebSearchMode,
    bypass: false,
  };
}

export function getSessionPermissionSummary(session: ThreadSession): string {
  if (session.provider === 'claude') {
    return resolveEffectiveClaudePermissionMode(session);
  }

  const codex = resolveEffectiveCodexOptions(session);
  if (codex.bypass) return 'bypass';
  return `${codex.sandboxMode} | ${codex.approvalPolicy} | net:${codex.networkAccessEnabled ? 'on' : 'off'} | search:${codex.webSearchMode}`;
}

export function getSessionPermissionDetails(session: ThreadSession): string {
  if (session.provider === 'claude') {
    return `Claude: ${resolveEffectiveClaudePermissionMode(session)}`;
  }

  const codex = resolveEffectiveCodexOptions(session);
  return [
    `sandbox=${codex.sandboxMode}`,
    `approval=${codex.approvalPolicy}`,
    `bypass=${codex.bypass ? 'on' : 'off'}`,
    `network=${codex.networkAccessEnabled ? 'on' : 'off'}`,
    `search=${codex.webSearchMode}`,
  ].join(' | ');
}

// ─── Bindings ─────────────────────────────────────────────────────────────────

export function setStatusCardBinding(
  sessionId: string,
  binding: { messageId?: string },
): void {
  const session = getSession(sessionId);
  if (!session) return;
  session.statusCardMessageId = binding.messageId;
  debouncedSave();
}

export function setCurrentInteractionMessage(
  sessionId: string,
  messageId: string | undefined,
): void {
  const session = getSession(sessionId);
  if (!session) return;
  session.currentInteractionMessageId = messageId;
  debouncedSave();
}

// ─── End session ──────────────────────────────────────────────────────────────

export async function endSession(id: string): Promise<void> {
  const session = getSession(id);
  if (!session) return; // Idempotent: already ended

  const controller = sessionControllers.get(session.id);
  if (controller && session.isGenerating) {
    controller.abort();
  }
  sessionControllers.delete(session.id);
  sessionAbortReasons.delete(session.id);

  idToChannelId.delete(session.id);
  if (session.providerSessionId) {
    providerSessionIndex.delete(session.providerSessionId);
  }
  sessions.delete(session.channelId);

  const categorySet = sessionsByCategory.get(session.categoryId);
  if (categorySet) {
    categorySet.delete(session.channelId);
    if (categorySet.size === 0) {
      sessionsByCategory.delete(session.categoryId);
    }
  }

  cleanupSessionPanel(session.id);
  await saveSessionsImmediate();
}

// ─── State management ─────────────────────────────────────────────────────────

export function setMode(sessionId: string, mode: SessionMode): void {
  const session = getSession(sessionId);
  if (session) {
    session.mode = mode;
    if (mode === 'monitor') {
      session.monitorProviderSessionId = undefined;
    }
    session.workflowState = createDefaultWorkflowState();
    debouncedSave();
  }
}

export function setVerbose(sessionId: string, verbose: boolean): void {
  const session = getSession(sessionId);
  if (session) {
    session.verbose = verbose;
    debouncedSave();
  }
}

export function setModel(sessionId: string, model: string): void {
  const session = getSession(sessionId);
  if (session) {
    session.model = model;
    debouncedSave();
  }
}

export function setAgentPersona(sessionId: string, persona: string | undefined): void {
  const session = getSession(sessionId);
  if (session) {
    session.agentPersona = persona;
    debouncedSave();
  }
}

export function setMonitorGoal(sessionId: string, goal: string | undefined): void {
  const session = getSession(sessionId);
  if (session) {
    session.monitorGoal = goal;
    if (!goal) {
      session.monitorProviderSessionId = undefined;
    }
    session.workflowState = createDefaultWorkflowState();
    debouncedSave();
  }
}

export function updateWorkflowState(
  sessionId: string,
  patch: Partial<SessionWorkflowState> | ((current: SessionWorkflowState) => SessionWorkflowState),
): void {
  const session = getSession(sessionId);
  if (!session) return;

  const next =
    typeof patch === 'function'
      ? patch(session.workflowState)
      : { ...session.workflowState, ...patch };

  session.workflowState = {
    ...next,
    updatedAt: Date.now(),
  };
  debouncedSave();
}

export function resetWorkflowState(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) return;
  session.workflowState = createDefaultWorkflowState();
  debouncedSave();
}

// ─── Abort management ─────────────────────────────────────────────────────────

export function abortSession(sessionId: string): boolean {
  return abortSessionWithReason(sessionId, 'user');
}

export function abortSessionWithReason(sessionId: string, reason: 'user' | 'watchdog'): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  const controller = sessionControllers.get(session.id);
  sessionAbortReasons.set(session.id, reason);

  if (controller) {
    controller.abort();
  }

  if (session.isGenerating) {
    session.isGenerating = false;
    sessionControllers.delete(session.id);
    debouncedSave();
    return true;
  }

  return !!controller;
}

export function consumeAbortReason(sessionId: string): 'user' | 'watchdog' | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const reason = sessionAbortReasons.get(session.id);
  sessionAbortReasons.delete(session.id);
  return reason;
}

// ─── Abort controller access (for executor) ───────────────────────────────────

export function getSessionController(sessionId: string): AbortController | undefined {
  const session = getSession(sessionId);
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
  const session = getSession(sessionId);
  if (!session) return;
  session.isGenerating = generating;
  session.lastActivity = Date.now();
  if (!generating) {
    void saveSessionsImmediate();
  }
}

export function saveSessionImmediate(): Promise<void> {
  return saveSessionsImmediate();
}

export function debouncedSaveSession(): void {
  debouncedSave();
}
