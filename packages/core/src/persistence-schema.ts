// 持久化数据的运行时 schema 校验
// 解析从磁盘加载的 sessions.json/projects.json，容错处理损坏或缺字段的记录。
// 策略：
//   - 必填字段缺失 → 丢弃整条记录（记录 issue）
//   - 可选字段错误 → 丢弃该字段，保留其余
//   - 数组字段错误 → 视为空数组

import { s, type FieldSpec, type SchemaIssue } from './schema.ts';
import type {
  SessionPersistData,
  Project,
  ProviderName,
  SessionMode,
  SessionType,
  ClaudePermissionMode,
  SessionWorkflowState,
  SessionWorkflowStatus,
  Skill,
  McpServer,
} from './types.ts';

const PROVIDER_NAMES: readonly ProviderName[] = ['claude', 'codex'];
const SESSION_MODES: readonly SessionMode[] = ['auto', 'plan', 'normal', 'monitor'];
const SESSION_TYPES: readonly SessionType[] = ['persistent', 'subagent'];
const CLAUDE_PERM: readonly ClaudePermissionMode[] = ['bypass', 'normal'];
const CODEX_SANDBOX = ['read-only', 'workspace-write', 'danger-full-access'] as const;
const CODEX_APPROVAL = ['never', 'on-request', 'on-failure', 'untrusted'] as const;
const CODEX_WEB_SEARCH = ['disabled', 'cached', 'live'] as const;
const DISCOVERY_SOURCES = ['discord', 'claude-hook', 'codex-log', 'sync'] as const;
const WORKFLOW_STATUSES: readonly SessionWorkflowStatus[] = [
  'idle',
  'worker_running',
  'retrying',
  'monitor_review',
  'awaiting_human',
  'completed',
  'blocked',
  'error',
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseWorkflowState(raw: unknown, path: string, issues: SchemaIssue[]): SessionWorkflowState {
  const defaults: SessionWorkflowState = {
    status: 'idle',
    iteration: 0,
    updatedAt: Date.now(),
  };
  if (!isObject(raw)) {
    return defaults;
  }
  const status = s.literal(WORKFLOW_STATUSES, { default: 'idle' }).parse(
    raw.status,
    `${path}.status`,
    issues,
  ) as SessionWorkflowStatus;
  const iteration = s.number({ integer: true, default: 0 }).parse(
    raw.iteration,
    `${path}.iteration`,
    issues,
  ) as number;
  const updatedAt = s.number({ default: Date.now() }).parse(
    raw.updatedAt,
    `${path}.updatedAt`,
    issues,
  ) as number;
  const workflow: SessionWorkflowState = { status, iteration, updatedAt };
  // 其余为可选字段，值错误时丢弃即可
  if (typeof raw.lastHook === 'string') workflow.lastHook = raw.lastHook as SessionWorkflowState['lastHook'];
  if (typeof raw.lastWorkerSummary === 'string') workflow.lastWorkerSummary = raw.lastWorkerSummary;
  if (typeof raw.lastMonitorRationale === 'string') workflow.lastMonitorRationale = raw.lastMonitorRationale;
  if (typeof raw.awaitingHumanReason === 'string') workflow.awaitingHumanReason = raw.awaitingHumanReason;
  // 以下复合字段沿用原样（为工作流恢复而保留）
  if (isObject(raw.lastWorkerReport)) {
    workflow.lastWorkerReport = raw.lastWorkerReport as unknown as SessionWorkflowState['lastWorkerReport'];
  }
  if (isObject(raw.lastMonitorDecision)) {
    workflow.lastMonitorDecision = raw.lastMonitorDecision as unknown as SessionWorkflowState['lastMonitorDecision'];
  }
  if (isObject(raw.nextProofContract)) {
    workflow.nextProofContract = raw.nextProofContract as unknown as SessionWorkflowState['nextProofContract'];
  }
  return workflow;
}

export function parseSessionPersistData(raw: unknown, index: number, issues: SchemaIssue[]): SessionPersistData | undefined {
  if (!isObject(raw)) {
    issues.push({ path: `sessions[${index}]`, message: 'expected object, got ' + typeof raw });
    return undefined;
  }
  const path = `sessions[${index}]`;

  const id = s.string().parse(raw.id, `${path}.id`, issues);
  const channelId = s.string().parse(raw.channelId, `${path}.channelId`, issues);
  const categoryId = s.string().parse(raw.categoryId, `${path}.categoryId`, issues);
  const projectName = s.string().parse(raw.projectName, `${path}.projectName`, issues);
  const agentLabel = s.string().parse(raw.agentLabel, `${path}.agentLabel`, issues);
  const directory = s.string().parse(raw.directory, `${path}.directory`, issues);

  if (!id || !channelId || !categoryId || !projectName || !agentLabel || !directory) {
    return undefined;
  }

  const provider = s.literal(PROVIDER_NAMES, { default: 'claude' }).parse(
    raw.provider,
    `${path}.provider`,
    issues,
  ) as ProviderName;
  const mode = s.literal(SESSION_MODES, { default: 'auto' }).parse(
    raw.mode,
    `${path}.mode`,
    issues,
  ) as SessionMode;
  const type = s.literal(SESSION_TYPES, { default: 'persistent' }).parse(
    raw.type,
    `${path}.type`,
    issues,
  ) as SessionType;

  const now = Date.now();
  const session: SessionPersistData = {
    id,
    channelId,
    categoryId,
    projectName,
    agentLabel,
    provider,
    type,
    mode,
    directory,
    subagentDepth: s.number({ integer: true, default: 0 }).parse(raw.subagentDepth, `${path}.subagentDepth`, issues) as number,
    verbose: s.boolean({ default: false }).parse(raw.verbose, `${path}.verbose`, issues) as boolean,
    workflowState: parseWorkflowState(raw.workflowState, `${path}.workflowState`, issues),
    createdAt: s.number({ default: now }).parse(raw.createdAt, `${path}.createdAt`, issues) as number,
    lastActivity: s.number({ default: now }).parse(raw.lastActivity, `${path}.lastActivity`, issues) as number,
    messageCount: s.number({ integer: true, default: 0 }).parse(raw.messageCount, `${path}.messageCount`, issues) as number,
    totalCost: s.number({ default: 0 }).parse(raw.totalCost, `${path}.totalCost`, issues) as number,
    currentTurn: s.number({ integer: true, default: 0 }).parse(raw.currentTurn, `${path}.currentTurn`, issues) as number,
    humanResolved: s.boolean({ default: false }).parse(raw.humanResolved, `${path}.humanResolved`, issues) as boolean,
  };

  // 可选字段：类型错误时丢弃，不阻断恢复
  if (typeof raw.providerSessionId === 'string') session.providerSessionId = raw.providerSessionId;
  if (typeof raw.model === 'string') session.model = raw.model;
  if (typeof raw.parentChannelId === 'string') session.parentChannelId = raw.parentChannelId;
  if (typeof raw.agentPersona === 'string') session.agentPersona = raw.agentPersona;
  if (typeof raw.monitorGoal === 'string') session.monitorGoal = raw.monitorGoal;
  if (typeof raw.monitorProviderSessionId === 'string') session.monitorProviderSessionId = raw.monitorProviderSessionId;
  if (typeof raw.currentInteractionMessageId === 'string') session.currentInteractionMessageId = raw.currentInteractionMessageId;
  if (typeof raw.statusCardMessageId === 'string') session.statusCardMessageId = raw.statusCardMessageId;
  if (typeof raw.lastInboundMessageId === 'string') session.lastInboundMessageId = raw.lastInboundMessageId;
  if (typeof raw.lastObservedState === 'string') session.lastObservedState = raw.lastObservedState;
  if (typeof raw.lastObservedEventKey === 'string') session.lastObservedEventKey = raw.lastObservedEventKey;
  if (typeof raw.lastObservedAt === 'number') session.lastObservedAt = raw.lastObservedAt;
  if (typeof raw.lastObservedCwd === 'string') session.lastObservedCwd = raw.lastObservedCwd;
  if (typeof raw.activeHumanGateId === 'string') session.activeHumanGateId = raw.activeHumanGateId;
  if (typeof raw.remoteHumanControl === 'boolean') session.remoteHumanControl = raw.remoteHumanControl;

  if (typeof raw.claudePermissionMode === 'string' && CLAUDE_PERM.includes(raw.claudePermissionMode as ClaudePermissionMode)) {
    session.claudePermissionMode = raw.claudePermissionMode as ClaudePermissionMode;
  }
  if (typeof raw.codexSandboxMode === 'string' && (CODEX_SANDBOX as readonly string[]).includes(raw.codexSandboxMode)) {
    session.codexSandboxMode = raw.codexSandboxMode as SessionPersistData['codexSandboxMode'];
  }
  if (typeof raw.codexApprovalPolicy === 'string' && (CODEX_APPROVAL as readonly string[]).includes(raw.codexApprovalPolicy)) {
    session.codexApprovalPolicy = raw.codexApprovalPolicy as SessionPersistData['codexApprovalPolicy'];
  }
  if (typeof raw.codexBypass === 'boolean') session.codexBypass = raw.codexBypass;
  if (typeof raw.codexNetworkAccessEnabled === 'boolean') session.codexNetworkAccessEnabled = raw.codexNetworkAccessEnabled;
  if (typeof raw.codexWebSearchMode === 'string' && (CODEX_WEB_SEARCH as readonly string[]).includes(raw.codexWebSearchMode)) {
    session.codexWebSearchMode = raw.codexWebSearchMode as SessionPersistData['codexWebSearchMode'];
  }
  if (typeof raw.discoverySource === 'string' && (DISCOVERY_SOURCES as readonly string[]).includes(raw.discoverySource)) {
    session.discoverySource = raw.discoverySource as SessionPersistData['discoverySource'];
  }

  return session;
}

// ── Project ────────────────────────────────────────────────────────────────

function parseSkill(raw: unknown): Skill | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.name !== 'string' || typeof raw.prompt !== 'string') return undefined;
  return { name: raw.name, prompt: raw.prompt };
}

function parseMcpServer(raw: unknown): McpServer | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.name !== 'string' || typeof raw.command !== 'string') return undefined;
  const server: McpServer = { name: raw.name, command: raw.command };
  if (Array.isArray(raw.args)) {
    server.args = raw.args.filter((a): a is string => typeof a === 'string');
  }
  return server;
}

const skillSpec: FieldSpec<Skill | undefined> = {
  parse(input) {
    return parseSkill(input);
  },
};

const mcpSpec: FieldSpec<McpServer | undefined> = {
  parse(input) {
    return parseMcpServer(input);
  },
};

export function parseProject(raw: unknown, index: number, issues: SchemaIssue[]): Project | undefined {
  if (!isObject(raw)) {
    issues.push({ path: `projects[${index}]`, message: 'expected object, got ' + typeof raw });
    return undefined;
  }
  const path = `projects[${index}]`;

  const categoryId = s.string().parse(raw.categoryId, `${path}.categoryId`, issues);
  const name = s.string().parse(raw.name, `${path}.name`, issues);
  const directory = s.string().parse(raw.directory, `${path}.directory`, issues);
  if (!categoryId || !name || !directory) return undefined;

  const project: Project = {
    categoryId,
    name,
    directory,
    skills: (s.array(skillSpec, { default: [] }).parse(raw.skills, `${path}.skills`, issues) ?? []).filter(
      (skill): skill is Skill => skill !== undefined,
    ),
    mcpServers: (s.array(mcpSpec, { default: [] }).parse(raw.mcpServers, `${path}.mcpServers`, issues) ?? []).filter(
      (server): server is McpServer => server !== undefined,
    ),
    createdAt: s.number({ default: Date.now() }).parse(raw.createdAt, `${path}.createdAt`, issues) as number,
  };

  if (typeof raw.historyChannelId === 'string') project.historyChannelId = raw.historyChannelId;
  if (typeof raw.controlChannelId === 'string') project.controlChannelId = raw.controlChannelId;
  if (typeof raw.personality === 'string') project.personality = raw.personality;

  return project;
}

/**
 * RegisteredProject 对象的校验（与 Project 形态不同；由 engine/project-registry 使用）。
 * - 必填：id、name、path
 * - 可选字段类型错误时丢弃，保证持久化恢复不中断
 */
export interface RegisteredProjectLike {
  id: string;
  name: string;
  path: string;
  discordCategoryId?: string;
  discordCategoryName?: string;
  historyChannelId?: string;
  controlChannelId?: string;
  personality?: string;
  skills: Record<string, string>;
  mcpServers: McpServer[];
  createdAt: number;
  updatedAt: number;
}

export function parseRegisteredProject(
  raw: unknown,
  index: number,
  issues: SchemaIssue[],
): RegisteredProjectLike | undefined {
  if (!isObject(raw)) {
    issues.push({ path: `projects[${index}]`, message: 'expected object, got ' + typeof raw });
    return undefined;
  }
  const path = `projects[${index}]`;
  const id = s.string().parse(raw.id, `${path}.id`, issues);
  const name = s.string().parse(raw.name, `${path}.name`, issues);
  const projectPath = s.string().parse(raw.path, `${path}.path`, issues);
  if (!id || !name || !projectPath) return undefined;

  const now = Date.now();
  const project: RegisteredProjectLike = {
    id,
    name,
    path: projectPath,
    skills: {},
    mcpServers: [],
    createdAt: s.number({ default: now }).parse(raw.createdAt, `${path}.createdAt`, issues) as number,
    updatedAt: s.number({ default: now }).parse(raw.updatedAt, `${path}.updatedAt`, issues) as number,
  };

  if (isObject(raw.skills)) {
    for (const [key, value] of Object.entries(raw.skills)) {
      if (typeof value === 'string') project.skills[key] = value;
    }
  }
  if (Array.isArray(raw.mcpServers)) {
    for (const item of raw.mcpServers) {
      const parsed = parseMcpServer(item);
      if (parsed) project.mcpServers.push(parsed);
    }
  }

  if (typeof raw.discordCategoryId === 'string') project.discordCategoryId = raw.discordCategoryId;
  if (typeof raw.discordCategoryName === 'string') project.discordCategoryName = raw.discordCategoryName;
  if (typeof raw.historyChannelId === 'string') project.historyChannelId = raw.historyChannelId;
  if (typeof raw.controlChannelId === 'string') project.controlChannelId = raw.controlChannelId;
  if (typeof raw.personality === 'string') project.personality = raw.personality;

  return project;
}
