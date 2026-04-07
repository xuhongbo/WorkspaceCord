import { sep } from 'node:path';
import { resolvePath } from '../utils.ts';
import type { ThreadSession, ProviderName } from '../types.ts';
import * as registry from '../session-registry.ts';

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

  const { isArchivedProviderSession } = await import('../archive-manager.ts');
  if (isArchivedProviderSession(provider, effectiveProviderSessionId)) {
    console.log(
      `[registerLocalSession] Skip archived ${provider} session ${effectiveProviderSessionId} ` +
      `(source: ${discoverySource})`,
    );
    return null;
  }

  const existing = registry.getSessionByProviderSession(provider, effectiveProviderSessionId);
  if (existing) {
    updateLocalObservation(existing.id, { discoverySource, cwd, remoteHumanControl });
    return { session: existing, isNewlyCreated: false };
  }

  const { getProjectByPath, getAllRegisteredProjects } = await import('../project-registry.ts');
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
      `cwd "${cwd}" does not belong to any mounted project`,
    );
    return null;
  }

  const category = guild.channels.cache.get(project.discordCategoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    console.warn(
      `[registerLocalSession] Cannot register ${provider} session ${providerSessionId}: ` +
      `category ${project.discordCategoryId} not found`,
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

  const base = labelHint
    ? labelHint
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
    : effectiveProviderSessionId.slice(0, 12);

  const channelName = `${provider}-${base}`.slice(0, 100);

  let channel = category.children.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      typeof ch.topic === 'string' &&
      ch.topic.includes(`Provider Session: ${effectiveProviderSessionId}`),
  );

  if (!channel) {
    channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `${provider} session (local) | Provider Session: ${effectiveProviderSessionId}`,
    });
  }

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
    `(source: ${discoverySource}, channel: ${channel.id})`,
  );

  return { session, isNewlyCreated: true };
}
