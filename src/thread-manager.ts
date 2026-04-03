// Thread Manager — Provider 委托与本地会话注册
// 职责：系统提示词构建、Provider 调用、本地会话注册（含 Discord 频道创建）

import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { ensureProvider, type ProviderEvent, type ContentBlock } from './providers/index.ts';
import { getAgent } from './agents.ts';
import { getPersonality } from './project-manager.ts';
import { resolvePath, isAbortError } from './utils.ts';
import type { ThreadSession, ProviderName } from './types.ts';
import { config } from './config.ts';
import type { ProviderCanUseTool } from './providers/types.ts';
import { buildDiscordSessionMessageContext } from './discord/session-message-context.ts';
import * as registry from './session-registry.ts';

// Re-export the full registry API for backwards compatibility
export {
  loadSessions, createSession, getSession, getSessionByChannel, getSessionByThread,
  getSessionByCodexId, getSessionByProviderSession, getSessionsByCategory, getAllSessions,
  findCodexSessionForMonitor, findCodexSessionByProviderSessionId, findCodexSessionByCwd,
  resolveCodexSessionFromMonitor, updateSession, updateSessionPermissions,
  resolveEffectiveClaudePermissionMode, resolveEffectiveCodexOptions,
  getSessionPermissionSummary, getSessionPermissionDetails, setStatusCardBinding,
  setCurrentInteractionMessage, endSession, setMode, setVerbose, setModel,
  setAgentPersona, setMonitorGoal, updateWorkflowState, resetWorkflowState,
  abortSession, abortSessionWithReason, consumeAbortReason,
} from './session-registry.ts';
export type { CreateSessionParams } from './session-registry.ts';

// ─── Mode prompts ─────────────────────────────────────────────────────────────

const MODE_PROMPTS: Record<ThreadSession['mode'], string> = {
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

  parts.push(buildDiscordSessionMessageContext());

  return parts;
}

function buildMonitorSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  parts.push(MONITOR_SYSTEM_PROMPT);
  parts.push(buildDiscordSessionMessageContext());
  return parts;
}

// ─── Provider options builder ─────────────────────────────────────────────────

function buildProviderOptions(
  session: ThreadSession,
  controller: AbortController,
  isMonitor = false,
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): import('./providers/types.ts').ProviderSessionOptions {
  const effectiveCodex = registry.resolveEffectiveCodexOptions(session);

  return {
    directory: session.directory,
    providerSessionId: isMonitor ? session.monitorProviderSessionId : session.providerSessionId,
    model: session.model,
    sandboxMode: effectiveCodex.sandboxMode,
    approvalPolicy: effectiveCodex.approvalPolicy,
    networkAccessEnabled: effectiveCodex.networkAccessEnabled,
    webSearchMode: effectiveCodex.webSearchMode,
    modelReasoningEffort: config.codexReasoningEffort || undefined,
    claudePermissionMode: registry.resolveEffectiveClaudePermissionMode(session),
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
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): AsyncGenerator<ProviderEvent> {
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  registry.setSessionController(session.id, controller);
  registry.markSessionGenerating(session.id, true);

  const provider = await ensureProvider(session.provider);

  try {
    const stream = provider.sendPrompt(
      prompt,
      buildProviderOptions(session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        const s = registry.getSession(sessionId);
        if (s) {
          s.providerSessionId = event.providerSessionId || undefined;
          registry.debouncedSaveSession();
        }
      }
      if (event.type === 'result') {
        const s = registry.getSession(sessionId);
        if (s) s.totalCost += event.costUsd;
      }
      yield event;
    }

    const s = registry.getSession(sessionId);
    if (s) s.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // User cancelled — expected
    } else {
      throw err;
    }
  } finally {
    registry.markSessionGenerating(sessionId, false);
    registry.clearSessionController(sessionId);
    await registry.saveSessionImmediate();
  }
}

export async function* continueSession(sessionId: string): AsyncGenerator<ProviderEvent> {
  yield* continueSessionWithOverrides(sessionId);
}

export async function* continueSessionWithOverrides(
  sessionId: string,
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): AsyncGenerator<ProviderEvent> {
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  registry.setSessionController(session.id, controller);
  registry.markSessionGenerating(session.id, true);

  const provider = await ensureProvider(session.provider);

  try {
    const stream = provider.continueSession(
      buildProviderOptions(session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        const s = registry.getSession(sessionId);
        if (s) {
          s.providerSessionId = event.providerSessionId || undefined;
          registry.debouncedSaveSession();
        }
      }
      if (event.type === 'result') {
        const s = registry.getSession(sessionId);
        if (s) s.totalCost += event.costUsd;
      }
      yield event;
    }

    const s = registry.getSession(sessionId);
    if (s) s.messageCount++;
  } catch (err: unknown) {
    if (isAbortError(err)) {
      // cancelled
    } else {
      throw err;
    }
  } finally {
    registry.markSessionGenerating(sessionId, false);
    registry.clearSessionController(sessionId);
    await registry.saveSessionImmediate();
  }
}

export async function* sendMonitorPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<ProviderEvent> {
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const provider = await ensureProvider(session.provider);
  const s = registry.getSession(sessionId);
  if (s) s.lastActivity = Date.now();

  const controller = new AbortController();
  const stream = provider.sendPrompt(prompt, buildProviderOptions(session, controller, true));

  for await (const event of stream) {
    if (event.type === 'session_init') {
      const cur = registry.getSession(sessionId);
      if (cur) {
        cur.monitorProviderSessionId = event.providerSessionId || undefined;
        registry.debouncedSaveSession();
      }
    }
    if (event.type === 'result') {
      const cur = registry.getSession(sessionId);
      if (cur) cur.totalCost += event.costUsd;
    }
    yield event;
  }

  const cur = registry.getSession(sessionId);
  if (cur) cur.lastActivity = Date.now();
  registry.debouncedSaveSession();
}

// ─── Local session helpers ────────────────────────────────────────────────────

export function buildClaudeSubagentProviderSessionId(
  parentProviderSessionId: string,
  agentId: string,
): string {
  return `subagent:${parentProviderSessionId}:${agentId}`;
}

export function updateLocalObservation(
  sessionId: string,
  patch: { discoverySource: 'claude-hook' | 'codex-log' | 'sync'; cwd: string; remoteHumanControl?: boolean },
): void {
  registry.updateSession(sessionId, {
    discoverySource: patch.discoverySource,
    lastObservedAt: Date.now(),
    lastObservedCwd: resolvePath(patch.cwd),
    ...(patch.remoteHumanControl !== undefined ? { remoteHumanControl: patch.remoteHumanControl } : {}),
  });
}

// ─── Register local session ───────────────────────────────────────────────────

export interface RegisterLocalSessionParams {
  provider: ProviderName;
  providerSessionId: string;
  cwd: string;
  discoverySource: 'claude-hook' | 'codex-log' | 'sync';
  labelHint?: string;
  remoteHumanControl?: boolean;
  subagent?: {
    parentProviderSessionId: string;
    depth?: number;
    agentId?: string;
    agentType?: string;
  };
}

export interface RegisterLocalSessionResult {
  session: ThreadSession;
  isNewlyCreated: boolean;
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
  const {
    provider,
    providerSessionId,
    cwd,
    discoverySource,
    labelHint,
    remoteHumanControl,
    subagent,
  } = params;
  const effectiveProviderSessionId =
    provider === 'claude' && subagent?.parentProviderSessionId && subagent.agentId
      ? buildClaudeSubagentProviderSessionId(subagent.parentProviderSessionId, subagent.agentId)
      : providerSessionId;
  const effectiveAgentLabel =
    subagent?.agentType || labelHint || effectiveProviderSessionId.slice(0, 12);

  const { isArchivedProviderSession } = await import('./archive-manager.ts');
  if (isArchivedProviderSession(provider, effectiveProviderSessionId)) {
    console.log(
      `[registerLocalSession] Skip archived ${provider} session ${effectiveProviderSessionId} ` +
      `(source: ${discoverySource})`
    );
    return null;
  }

  // 1. 检查是否已注册
  const existing = registry.getSessionByProviderSession(provider, effectiveProviderSessionId);
  if (existing) {
    updateLocalObservation(existing.id, { discoverySource, cwd, remoteHumanControl });
    return { session: existing, isNewlyCreated: false };
  }

  // 2. 根据 cwd 归属到已挂载项目
  const { getProjectByPath, getAllRegisteredProjects } = await import('./project-registry.ts');
  const { ChannelType, ThreadAutoArchiveDuration } = await import('discord.js');

  const normalizedCwd = resolvePath(cwd);
  let project = getProjectByPath(normalizedCwd);

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
  const category = guild.channels.cache.get(project.discordCategoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    console.warn(
      `[registerLocalSession] Cannot register ${provider} session ${providerSessionId}: ` +
      `category ${project.discordCategoryId} not found`
    );
    return null;
  }

  if (subagent?.parentProviderSessionId) {
    const parentSession = registry.getSessionByProviderSession(provider, subagent.parentProviderSessionId);
    if (!parentSession) {
      console.warn(
        `[registerLocalSession] Delaying subagent ${provider} session ${providerSessionId}: ` +
          `parent provider session ${subagent.parentProviderSessionId} not registered yet`,
      );
      return null;
    }

    const parentChannel = guild.channels.cache.get(parentSession.channelId);
    const threadHostChannel =
      parentChannel?.type === ChannelType.GuildText
        ? parentChannel
        : parentChannel?.isThread?.() || parentChannel?.type === ChannelType.PublicThread
          ? parentChannel.parent
          : undefined;
    if (threadHostChannel?.type !== ChannelType.GuildText) {
      console.warn(
        `[registerLocalSession] Delaying subagent ${provider} session ${providerSessionId}: ` +
          `parent channel ${parentSession.channelId} is unavailable`,
      );
      return null;
    }

    const normalizedThreadName = `[sub:${provider}] ${effectiveAgentLabel}`.slice(0, 100);
    const thread = await threadHostChannel.threads.create({
      name: normalizedThreadName,
      type: ChannelType.PublicThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: `Auto-registered subagent session ${effectiveProviderSessionId}`,
    });

    const session = await registry.createSession({
      channelId: thread.id,
      categoryId: parentSession.categoryId,
      projectName: parentSession.projectName,
      agentLabel: effectiveAgentLabel,
      provider,
      providerSessionId: effectiveProviderSessionId,
      directory: normalizedCwd,
      type: 'subagent',
      parentChannelId:
        parentSession.type === 'subagent'
          ? parentSession.parentChannelId ?? threadHostChannel.id
          : parentSession.channelId,
      subagentDepth: Math.max(1, subagent.depth ?? parentSession.subagentDepth + 1),
      discoverySource,
      remoteHumanControl: remoteHumanControl ?? false,
    });

    updateLocalObservation(session.id, {
      discoverySource,
      cwd: normalizedCwd,
      remoteHumanControl: remoteHumanControl ?? false,
    });

    console.log(
      `[registerLocalSession] Registered subagent ${provider} session ${effectiveProviderSessionId} ` +
        `(source: ${discoverySource}, parent: ${parentSession.channelId}, thread: ${thread.id})`,
    );

    return { session, isNewlyCreated: true };
  }

  // 生成频道名称
  const base = labelHint
    ? labelHint
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
    : effectiveProviderSessionId.slice(0, 12);

  const channelName = `${provider}-${base}`.slice(0, 100);

  // 查找是否已有频道（通过 topic 匹配）
  let channel = category.children.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      typeof ch.topic === 'string' &&
      ch.topic.includes(`Provider Session: ${effectiveProviderSessionId}`)
  );

  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${provider} session (local) | Provider Session: ${effectiveProviderSessionId}`,
    });
  }

  // 4. 创建 ThreadSession
  const session = await registry.createSession({
    channelId: channel.id,
    categoryId: project.discordCategoryId,
    projectName: project.name,
    agentLabel: effectiveAgentLabel,
    provider,
    providerSessionId: effectiveProviderSessionId,
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
    `[registerLocalSession] Registered ${provider} session ${effectiveProviderSessionId} ` +
    `(source: ${discoverySource}, channel: ${channel.id})`
  );

  return { session, isNewlyCreated: true };
}
