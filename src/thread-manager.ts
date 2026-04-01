import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { ensureProvider, type ProviderEvent, type ContentBlock } from './providers/index.ts';
import { Store } from './persistence.ts';
import { getAgent } from './agents.ts';
import { getPersonality } from './project-manager.ts';
import { sanitizeName, resolvePath, isAbortError } from './utils.ts';
import type {
  ThreadSession,
  SessionPersistData,
  SessionMode,
  SessionWorkflowState,
  ProviderName,
} from './types.ts';
import { config } from './config.ts';
import type { ProviderCanUseTool } from './providers/types.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODE_PROMPTS: Record<SessionMode, string> = {
  auto: '',
  plan: 'You MUST use EnterPlanMode at the start of every task. Present your plan for user approval before making any code changes. Do not write or edit files until the user approves the plan.',
  normal:
    'Before performing destructive or significant operations (deleting files, running dangerous commands, making large refactors, writing to many files), use AskUserQuestion to confirm with the user first. Ask for explicit approval before proceeding with changes.',
  monitor:
    'This session is running in monitored autonomy mode. Treat the active user request as the task objective and keep working until it is fully satisfied. Do not stop at a partial implementation or ask the user for follow-up direction unless you are truly blocked by missing permissions, credentials, or required external information that you cannot obtain yourself. When you believe the task is complete, explain concisely what was finished and why it satisfies the request.',
};

const MONITOR_SYSTEM_PROMPT = `You are a monitor agent supervising another coding agent.

Your job is to judge progress against the user's original request and decide whether the worker should continue.

Return JSON only in this schema:
{
  "status": "complete" | "continue" | "blocked",
  "confidence": "high" | "medium" | "low",
  "rationale": "Short explanation tied to the original request",
  "steering": "Concrete next instructions for the worker. Empty string only when status is complete.",
  "completionSummary": "Short summary of what is complete. Empty string unless status is complete."
}

Rules:
- Favor continuing unless the task clearly satisfies the original request.
- Judge against robustness, completeness, and the user's stated quality bar, not just whether some code changed.
- If the worker stopped early, ask for the next concrete step instead of accepting the output.
- Use "blocked" only for true blockers the worker cannot resolve autonomously.
- Never ask the human for optional next steps.
- Output valid JSON and nothing else.`;

// ─── Storage ──────────────────────────────────────────────────────────────────

const sessionStore = new Store<SessionPersistData[]>('sessions.json');

// channelId (the session's own Discord channel or thread ID) → ThreadSession
const sessions = new Map<string, ThreadSession>();

// internal session id → channelId
const idToChannelId = new Map<string, string>();

// categoryId → Set<channelId> (索引，用于快速查找)
const sessionsByCategory = new Map<string, Set<string>>();

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
      workflowState: s.workflowState ?? createDefaultWorkflowState(),
      currentTurn: s.currentTurn ?? 0,
      humanResolved: s.humanResolved ?? false,
      currentInteractionMessageId: s.currentInteractionMessageId,
      statusCardMessageId: s.statusCardMessageId,
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
  channelId: string; // Session's own Discord channel (TextChannel) or thread ID
  categoryId: string; // Parent project category ID
  projectName: string;
  agentLabel: string;
  provider: ProviderName;
  directory: string;
  providerSessionId?: string;
  model?: string;
  type: 'persistent' | 'subagent';
  parentChannelId?: string; // For subagents: parent session's TextChannel ID
  subagentDepth?: number;
  mode?: SessionMode;
  claudePermissionMode?: 'bypass' | 'normal';
  discoverySource?: 'discord' | 'claude-hook' | 'codex-log' | 'sync';
  remoteHumanControl?: boolean; // 是否为受管会话（阶段五）
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
    discoverySource = 'discord',
    remoteHumanControl,
  } = params;

  const resolvedDir = resolvePath(params.directory);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  await ensureProvider(provider);

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
    discoverySource,
    remoteHumanControl,
  };

  sessions.set(channelId, session);
  idToChannelId.set(id, channelId);

  // 维护 category 索引
  if (!sessionsByCategory.has(categoryId)) {
    sessionsByCategory.set(categoryId, new Set());
  }
  sessionsByCategory.get(categoryId)!.add(channelId);

  await saveSessionsImmediate();

  return session;
}

export function getSession(id: string): ThreadSession | undefined {
  const channelId = idToChannelId.get(id);
  return channelId ? sessions.get(channelId) : undefined;
}

/** Look up a session by its Discord channel or thread ID. */
export function getSessionByChannel(channelId: string): ThreadSession | undefined {
  return sessions.get(channelId);
}

/** Backward-compat alias (subagent sessions are still threads). */
export const getSessionByThread = getSessionByChannel;

export function getSessionByCodexId(codexSessionId: string): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.provider === 'codex' && session.providerSessionId === codexSessionId) {
      return session;
    }
  }
  return undefined;
}

export function getSessionByProviderSession(
  provider: ProviderName,
  providerSessionId: string,
): ThreadSession | undefined {
  if (!providerSessionId) return undefined;
  for (const session of sessions.values()) {
    if (session.provider !== provider) continue;
    if (session.providerSessionId === providerSessionId) return session;
  }
  return undefined;
}

/** List all sessions under a project category. */
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

export function getSessionByProviderSessionId(
  provider: ProviderName,
  providerSessionId: string,
): ThreadSession | undefined {
  for (const session of sessions.values()) {
    if (session.provider !== provider) continue;
    if (!session.providerSessionId) continue;
    if (session.providerSessionId === providerSessionId) return session;
  }
  return undefined;
}

export function findCodexSessionForMonitor(
  providerSessionId: string | undefined,
  cwd: string | undefined,
): ThreadSession | undefined {
  if (providerSessionId) {
    const byProviderId = getSessionByProviderSessionId('codex', providerSessionId);
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
  for (const session of sessions.values()) {
    if (session.provider !== 'codex') continue;
    if (!session.providerSessionId) continue;
    if (session.providerSessionId === normalized || session.providerSessionId === providerSessionId) {
      return session;
    }
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

export function updateSession(
  sessionId: string,
  patch: Partial<ThreadSession>,
): void {
  const session = getSession(sessionId);
  if (!session) return;
  Object.assign(session, patch);
  debouncedSave();
}

export function setStatusCardBinding(
  sessionId: string,
  binding: {
    messageId?: string;
  },
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

export async function endSession(id: string): Promise<void> {
  const session = getSession(id);
  if (!session) throw new Error(`Session "${id}" not found`);

  // 清理运行时状态
  const controller = sessionControllers.get(session.id);
  if (controller && session.isGenerating) {
    controller.abort();
  }
  sessionControllers.delete(session.id);
  sessionAbortReasons.delete(session.id);

  // 清理索引
  idToChannelId.delete(session.id);
  sessions.delete(session.channelId);

  const categorySet = sessionsByCategory.get(session.categoryId);
  if (categorySet) {
    categorySet.delete(session.channelId);
    if (categorySet.size === 0) {
      sessionsByCategory.delete(session.categoryId);
    }
  }

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

// ─── System prompt building ───────────────────────────────────────────────────

function buildSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  if (session.agentPersona) {
    const agent = getAgent(session.agentPersona);
    if (agent?.systemPrompt) parts.push(agent.systemPrompt);
  }

  const modePrompt = MODE_PROMPTS[session.mode];
  if (modePrompt) parts.push(modePrompt);

  return parts;
}

function buildMonitorSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  parts.push(MONITOR_SYSTEM_PROMPT);
  return parts;
}

// ─── Provider options builder ─────────────────────────────────────────────────

function buildProviderOptions(
  session: ThreadSession,
  controller: AbortController,
  isMonitor = false,
  runtimeOverrides: {
    canUseTool?: ProviderCanUseTool;
  } = {},
): import('./providers/types.ts').ProviderSessionOptions {
  const isAutoMode = session.mode === 'auto';

  return {
    directory: session.directory,
    providerSessionId: isMonitor ? session.monitorProviderSessionId : session.providerSessionId,
    model: session.model,
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: isAutoMode ? 'never' : config.codexApprovalPolicy,
    networkAccessEnabled: config.codexNetworkAccessEnabled,
    webSearchMode: config.codexWebSearchMode,
    modelReasoningEffort: config.codexReasoningEffort || undefined,
    claudePermissionMode: isAutoMode
      ? 'bypass'
      : (session.claudePermissionMode ?? config.claudePermissionMode),
    systemPromptParts: isMonitor
      ? buildMonitorSystemPromptParts(session)
      : buildSystemPromptParts(session),
    abortController: controller,
    canUseTool: runtimeOverrides.canUseTool,
  };
}

// ─── Provider-delegated prompt sending ───────────────────────────────────────

export async function* sendPrompt(
  sessionId: string,
  prompt: string | ContentBlock[],
  runtimeOverrides: {
    canUseTool?: ProviderCanUseTool;
  } = {},
): AsyncGenerator<ProviderEvent> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  sessionControllers.set(session.id, controller);
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const provider = await ensureProvider(session.provider);

  try {
    const stream = provider.sendPrompt(prompt, buildProviderOptions(session, controller, false, runtimeOverrides));

    for await (const event of stream) {
      if (event.type === 'session_init') {
        session.providerSessionId = event.providerSessionId || undefined;
        debouncedSave();
      }
      if (event.type === 'result') {
        session.totalCost += event.costUsd;
      }
      yield event;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // User cancelled — expected
    } else {
      throw err;
    }
  } finally {
    session.isGenerating = false;
    session.lastActivity = Date.now();
    sessionControllers.delete(session.id);
    await saveSessionsImmediate();
  }
}

export async function* continueSession(sessionId: string): AsyncGenerator<ProviderEvent> {
  yield* continueSessionWithOverrides(sessionId);
}

export async function* continueSessionWithOverrides(
  sessionId: string,
  runtimeOverrides: {
    canUseTool?: ProviderCanUseTool;
  } = {},
): AsyncGenerator<ProviderEvent> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  sessionControllers.set(session.id, controller);
  session.isGenerating = true;
  session.lastActivity = Date.now();

  const provider = await ensureProvider(session.provider);

  try {
    const stream = provider.continueSession(
      buildProviderOptions(session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        session.providerSessionId = event.providerSessionId || undefined;
        debouncedSave();
      }
      if (event.type === 'result') {
        session.totalCost += event.costUsd;
      }
      yield event;
    }

    session.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // cancelled
    } else {
      throw err;
    }
  } finally {
    session.isGenerating = false;
    session.lastActivity = Date.now();
    sessionControllers.delete(session.id);
    await saveSessionsImmediate();
  }
}

export async function* sendMonitorPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<ProviderEvent> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const provider = await ensureProvider(session.provider);
  session.lastActivity = Date.now();

  const controller = new AbortController();
  const stream = provider.sendPrompt(prompt, buildProviderOptions(session, controller, true));

  for await (const event of stream) {
    if (event.type === 'session_init') {
      session.monitorProviderSessionId = event.providerSessionId || undefined;
      debouncedSave();
    }
    if (event.type === 'result') {
      session.totalCost += event.costUsd;
    }
    yield event;
  }

  session.lastActivity = Date.now();
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

// ─── 统一本地会话注册流程 ─────────────────────────────────────────────────────

export interface RegisterLocalSessionParams {
  provider: ProviderName;
  providerSessionId: string;
  cwd: string;
  discoverySource: 'claude-hook' | 'codex-log' | 'sync';
  labelHint?: string;
  remoteHumanControl?: boolean;
}

export interface RegisterLocalSessionResult {
  session: ThreadSession;
  isNewlyCreated: boolean;
}

interface LocalObservationPatch {
  discoverySource: 'claude-hook' | 'codex-log' | 'sync';
  cwd: string;
  remoteHumanControl?: boolean;
}

export function updateLocalObservation(
  sessionId: string,
  patch: LocalObservationPatch,
): void {
  const observationPatch: Partial<ThreadSession> = {
    discoverySource: patch.discoverySource,
    lastObservedAt: Date.now(),
    lastObservedCwd: resolvePath(patch.cwd),
  };

  if (patch.remoteHumanControl !== undefined) {
    observationPatch.remoteHumanControl = patch.remoteHumanControl;
  }

  updateSession(sessionId, observationPatch);
}

/**
 * 统一本地会话注册流程（设计文档 7.4 节）
 *
 * 1. 解析提供方、会话 ID、cwd
 * 2. 用 cwd 归属到已挂载项目
 * 3. 查找是否已有频道与会话
 * 4. 没有则创建，有则复用
 * 5. 初始化状态卡绑定
 *
 * 幂等性：重复调用不会创建重复会话
 */
export async function registerLocalSession(
  params: RegisterLocalSessionParams,
  guild: import('discord.js').Guild,
): Promise<RegisterLocalSessionResult | null> {
  const { provider, providerSessionId, cwd, discoverySource, labelHint, remoteHumanControl } = params;

  // 1. 检查是否已注册
  const existing = getSessionByProviderSessionId(provider, providerSessionId);
  if (existing) {
    updateLocalObservation(existing.id, {
      discoverySource,
      cwd,
      remoteHumanControl,
    });
    return { session: existing, isNewlyCreated: false };
  }

  // 2. 根据 cwd 归属到已挂载项目
  const { getProjectByPath, getAllRegisteredProjects } = await import('./project-registry.ts');
  const { resolvePath } = await import('./utils.ts');

  const normalizedCwd = resolvePath(cwd);
  let project = getProjectByPath(normalizedCwd);

  // 如果精确匹配失败，尝试找父目录匹配
  if (!project) {
    const allProjects = getAllRegisteredProjects();
    let bestMatch: (typeof allProjects)[number] | undefined;
    let bestMatchPathLength = -1;

    for (const p of allProjects) {
      const projectPath = resolvePath(p.path);
      if (normalizedCwd.startsWith(projectPath + sep) && projectPath.length > bestMatchPathLength) {
        bestMatch = p;
        bestMatchPathLength = projectPath.length;
      }
    }

    project = bestMatch;
  }

  if (!project || !project.discordCategoryId) {
    console.warn(
      `[registerLocalSession] Cannot register ${provider} session ${providerSessionId}: ` +
      `cwd "${cwd}" does not belong to any mounted project`
    );
    return null;
  }

  // 3. 查找或创建 Discord 频道
  const { ChannelType } = await import('discord.js');
  const category = guild.channels.cache.get(project.discordCategoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    console.warn(
      `[registerLocalSession] Cannot register ${provider} session ${providerSessionId}: ` +
      `category ${project.discordCategoryId} not found`
    );
    return null;
  }

  // 生成频道名称
  const base = labelHint
    ? labelHint
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
    : providerSessionId.slice(0, 12);

  const channelName = `${provider}-${base}`.slice(0, 100);

  // 查找是否已有频道（通过 topic 匹配）
  let channel = category.children.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      typeof ch.topic === 'string' &&
      ch.topic.includes(`Provider Session: ${providerSessionId}`)
  );

  // 如果没有，创建新频道
  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${provider} session (local) | Provider Session: ${providerSessionId}`,
    });
  }

  // 4. 创建 ThreadSession
  const session = await createSession({
    channelId: channel.id,
    categoryId: project.discordCategoryId,
    projectName: project.name,
    agentLabel: labelHint || providerSessionId.slice(0, 12),
    provider,
    providerSessionId,
    directory: normalizedCwd,
    type: 'persistent',
    discoverySource,
    remoteHumanControl: remoteHumanControl ?? false,
  });

  updateLocalObservation(session.id, {
    discoverySource,
    cwd: normalizedCwd,
    remoteHumanControl: remoteHumanControl ?? false,
  });

  console.log(
    `[registerLocalSession] Registered ${provider} session ${providerSessionId} ` +
    `(source: ${discoverySource}, channel: ${channel.id})`
  );

  return { session, isNewlyCreated: true };
}
