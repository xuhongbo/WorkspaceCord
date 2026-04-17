// Core type definitions for workspacecord
// Structure: Server=Workspace, Category=Project, Channel=Session, Thread=Subagent

export type ProviderName = 'claude' | 'codex';
export type SessionMode = 'auto' | 'plan' | 'normal' | 'monitor';
export type SessionType = 'persistent' | 'subagent';

// Backward compat alias
export type ThreadType = SessionType;

// ─── Channel Session ───────────────────────────────────────────────────────────
// One Discord channel/thread = one AI agent session
//   'persistent' → lives in a TextChannel under the project Category
//   'subagent'   → lives in a Thread under the parent session's TextChannel

export type ClaudePermissionMode = 'bypass' | 'normal';
export type CodexBypassMode = boolean;

/**
 * 持久化部分:落盘到 sessions.json 的字段,重启后完整恢复。
 *
 * 与 runtime 分离的意图:让 Repository 层的类型专注于"磁盘上应该有什么",
 * 避免 `isGenerating` 这种进程生命周期内才有意义的状态混入持久化路径。
 */
export interface SessionPersistent {
  id: string; // Internal session ID (sanitized agentLabel + dedup suffix)
  channelId: string; // Primary Discord ID: TextChannel.id for persistent, Thread.id for subagent
  categoryId: string; // Discord Category ID (= project)
  projectName: string; // Project name
  agentLabel: string; // Human-readable label, e.g. "fix-login"
  provider: ProviderName;
  providerSessionId?: string; // Provider-side session ID for resumption
  model?: string;
  type: SessionType;
  parentChannelId?: string; // For subagents: parent session's TextChannel ID
  subagentDepth: number; // Chain depth (0 = top-level)
  directory: string; // Working directory on host machine
  mode: SessionMode;
  agentPersona?: string; // Agent persona name
  verbose: boolean; // Show tool calls in Discord
  claudePermissionMode?: ClaudePermissionMode; // Claude-specific permission mode
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexApprovalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  codexBypass?: CodexBypassMode;
  codexNetworkAccessEnabled?: boolean;
  codexWebSearchMode?: 'disabled' | 'cached' | 'live';
  monitorGoal?: string;
  monitorProviderSessionId?: string;
  workflowState: SessionWorkflowState;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  totalCost: number;
  // 实时作战面板字段
  currentTurn: number; // 当前轮次（用于轮次化按钮）
  humanResolved: boolean; // 当前轮次是否已被人工处理
  currentInteractionMessageId?: string; // 当前等待人工的交互消息 ID
  statusCardMessageId?: string; // 常驻状态卡消息 ID
  lastInboundMessageId?: string; // 最近一条驱动本轮回复的入站消息 ID
  // 本地会话实时感知字段（设计文档 11.2 节）
  discoverySource?: 'discord' | 'claude-hook' | 'codex-log' | 'sync'; // 会话发现来源
  lastObservedState?: string; // 最近本地观察到的状态
  lastObservedEventKey?: string; // 最近本地观察到的事件键
  lastObservedAt?: number; // 最近本地观察时间戳
  lastObservedCwd?: string; // 最近本地观察到的工作目录
  remoteHumanControl?: boolean; // 是否支持远程人工控制（受管会话）
  activeHumanGateId?: string; // 当前活跃的人工门控 ID
}

/**
 * 运行时字段:只在进程内有意义,重启后应重置。
 * AbortController / abortReason 等更底层的运行时状态由 session-registry 的独立 Map
 * 维护,不在此接口里。
 */
export interface SessionRuntimeFields {
  isGenerating: boolean;
}

/**
 * 进程内使用的完整 session 视图。等同于 `SessionPersistent & SessionRuntimeFields`。
 * Repository 持久化的是 `SessionPersistent`,加载时补齐 runtime 默认值再暴露为
 * `ThreadSession` 给上层消费者。
 */
export interface ThreadSession extends SessionPersistent, SessionRuntimeFields {}

/**
 * 旧名字,保留向后兼容:等同于 `SessionPersistent`。
 * 新代码应使用 `SessionPersistent` 以表达"磁盘 schema"的意图。
 */
export type SessionPersistData = SessionPersistent;

// ─── Workflow State ───────────────────────────────────────────────────────────

export type SessionWorkflowStatus =
  | 'idle'
  | 'worker_running'
  | 'retrying'
  | 'monitor_review'
  | 'awaiting_human'
  | 'completed'
  | 'blocked'
  | 'error';

export type SessionWorkflowHookName =
  | 'before_worker_pass'
  | 'after_worker_pass'
  | 'before_monitor_review'
  | 'after_monitor_decision'
  | 'on_stall'
  | 'on_blocked'
  | 'on_complete'
  | 'on_human_question';

export interface SessionMonitorFeedbackReport {
  status: 'complete' | 'continue' | 'blocked';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  steering: string;
  completionSummary: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  disallowedDrift: string[];
  blockingReason: string;
}

export interface SessionWorkflowState {
  status: SessionWorkflowStatus;
  iteration: number;
  lastHook?: SessionWorkflowHookName;
  lastWorkerSummary?: string;
  lastWorkerReport?: SessionWorkerProgressReport;
  lastMonitorRationale?: string;
  lastMonitorDecision?: SessionMonitorFeedbackReport;
  nextProofContract?: SessionNextProofContract;
  awaitingHumanReason?: string;
  updatedAt: number;
}

// ─── Project ──────────────────────────────────────────────────────────────────
// One Discord Category = one project/repository

export interface Skill {
  name: string;
  prompt: string;
}

export interface McpServer {
  name: string;
  command: string;
  args?: string[];
}

export interface Project {
  categoryId: string; // Discord Category ID (primary key)
  historyChannelId?: string; // Forum channel ID for archived sessions
  controlChannelId?: string; // Dedicated text channel for spawning new sessions
  name: string; // Project name (= category name)
  directory: string; // Default working directory
  personality?: string; // Shared system prompt for all agents in this project
  skills: Skill[];
  mcpServers: McpServer[];
  createdAt: number;
}

export interface Config {
  token: string;
  clientId: string;
  guildId: string;
  allowedUsers: string[];
  allowAllUsers: boolean;
  dataDir: string;
  defaultProvider: ProviderName;
  defaultMode: SessionMode;
  claudePermissionMode: ClaudePermissionMode;
  maxSubagentDepth: number;
  maxActiveSessionsPerProject: number;
  autoArchiveDays: number;
  messageRetentionDays: number;
  rateLimitMs: number;
  shellEnabled: boolean;
  shellAllowedUsers: string[];
  codexSandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexApprovalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  codexNetworkAccessEnabled: boolean;
  codexWebSearchMode: 'disabled' | 'cached' | 'live';
  codexReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | '';
  monitorReasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | '';
  monitorClaudeModel: string;
  codexBaseUrl: string;
  codexApiKey: string;
  codexPath: string;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  sessionSyncIntervalMs: number;
  sessionSyncRecentDays: number;
}

// ─── Archived Session ─────────────────────────────────────────────────────────
// Sessions moved out of active channels and into the #history Forum

export interface ArchivedSession {
  id: string;
  categoryId: string;
  agentLabel: string;
  provider: ProviderName;
  providerSessionId?: string;
  directory: string;
  mode: SessionMode;
  createdAt: number;
  archivedAt: number;
  messageCount: number;
  totalCost: number;
  summary?: string;
  forumPostId?: string; // Discord Forum Post (Thread) ID
}

// ─── Workflow State (extended) ────────────────────────────────────────────────

export interface SessionWorkerProgressReport {
  originalGoal: string;
  textualResponse: string;
  commandCount: number;
  fileChangeCount: number;
  meaningfulExecutionEvidence: boolean;
  providerReportedSuccess: 'yes' | 'no' | 'unknown';
  workerErrorsObserved: boolean;
  askedForHumanInput: boolean;
  claimedCompletedOutcomes: string[];
  artifacts: string[];
  validationCommands: string[];
  goalAssessment: string;
  remainingGaps: string[];
  blockers: string[];
}

export interface SessionNextProofContract {
  goal: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  requiredArtifacts: string[];
  requiredValidation: string[];
  stopCondition: string;
  avoidUntilProved: string[];
}

// ─── Human Gate (人工门控) ────────────────────────────────────────────────────

export type HumanGateType = 'binary-approval' | 'text-question' | 'notification';
export type HumanGateStatus = 'pending' | 'approved' | 'denied' | 'answered' | 'expired' | 'invalidated';
export type HumanGateResolveSource = 'terminal' | 'discord' | 'timeout' | 'restart';

export interface HumanGate {
  id: string; // 唯一编号
  sessionId: string; // 所属会话
  provider: ProviderName; // 提供方
  type: HumanGateType; // 门控类型
  isBlocking: boolean; // 是否阻塞
  supportsRemoteDecision: boolean; // 是否支持 Discord 决策
  summary: string; // 摘要
  detail?: string; // 详细信息
  relatedCommand?: string; // 关联命令
  createdAt: number; // 创建时间
  status: HumanGateStatus; // 当前状态
  resolvedAt?: number; // 解决时间
  resolvedSource?: HumanGateResolveSource; // 解决来源
  resolvedAction?: string; // 解决动作（approve/deny/answer）
  interactionMessageId?: string; // 交互卡消息编号
  turn: number; // 所属轮次
}

// ─── Agent Persona ────────────────────────────────────────────────────────────

export interface AgentPersona {
  name: string;
  emoji: string;
  description: string;
  systemPrompt: string;
}

// ─── Shell Process ────────────────────────────────────────────────────────────

export interface ShellProcess {
  pid: number;
  command: string;
  startedAt: number;
  process: import('node:child_process').ChildProcess;
}

// ─── Expandable Content (for output-handler) ──────────────────────────────────

export interface ExpandableContent {
  content: string;
  createdAt: number;
}
