import {
  ChannelType,
  type ChatInputCommandInteraction,
  type TextChannel,
  type AnyThreadChannel,
  type Guild,
} from 'discord.js';
import { config, isUserAllowed } from '@workspacecord/core';
import { createSession, getSessionByChannel } from '@workspacecord/engine/session-registry';
import * as projectMgr from '@workspacecord/engine/project-manager';
import { buildProjectCleanupPreview } from './session-housekeeping.ts';
import type { ProviderName, SessionMode } from '@workspacecord/core';
import type { SessionChannel } from './discord-types.ts';

let logFn: (msg: string) => void = console.log;

export function setLogger(fn: (msg: string) => void): void {
  logFn = fn;
}

export function log(msg: string): void {
  logFn(msg);
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
};

export const PROVIDER_COLORS: Record<ProviderName, number> = {
  claude: 0x3498db,
  codex: 0x10a37f,
};


export const MODE_LABELS: Record<SessionMode, string> = {
  auto: '⚡ 自动模式 — 完全自主',
  plan: '📋 计划模式 — 变更前先规划',
  normal: '🛡️ 普通模式 — 破坏性操作前确认',
  monitor: '🧠 监控模式 — 持续引导直到完成',
};

export const CONTROL_CHANNEL_NAME = 'control';

const CLEANUP_PREVIEW_LIST_LIMIT = 10;
const CLEANUP_PREVIEW_LABEL_LIMIT = 120;

type ExistingStatusCardRegistrar = (
  sessionId: string,
  channel: TextChannel,
  statusCardMessageId: string,
) => Promise<void>;

export async function registerStatusCardWithPanelAdapter(
  sessionId: string,
  channel: TextChannel,
  statusCardMessageId: string,
): Promise<boolean> {
  const { registerExistingStatusCard } = await import('./panel-adapter.ts');

  if (typeof registerExistingStatusCard !== 'function') {
    log(`[panel-adapter] registerExistingStatusCard 未暴露，session=${sessionId}`);
    return false;
  }

  await registerExistingStatusCard(sessionId, channel, statusCardMessageId);
  return true;
}

function truncateCleanupLabel(label: string, max = CLEANUP_PREVIEW_LABEL_LIMIT): string {
  if (label.length <= max) return label;
  return `${label.slice(0, Math.max(0, max - 1))}…`;
}

function formatCleanupChannelLine(channelId: string, label?: string): string {
  return label ? `- <#${channelId}> ${truncateCleanupLabel(label)}` : `- <#${channelId}>`;
}

function appendCleanupPreviewSection(
  lines: string[],
  title: string,
  sessions: Array<{ channelId: string; agentLabel?: string }>,
): void {
  lines.push('', title);

  if (sessions.length === 0) {
    lines.push('- 无');
    return;
  }

  const visibleSessions = sessions.slice(0, CLEANUP_PREVIEW_LIST_LIMIT);
  lines.push(
    ...visibleSessions.map((session) =>
      formatCleanupChannelLine(session.channelId, session.agentLabel),
    ),
  );

  const remaining = sessions.length - visibleSessions.length;
  if (remaining > 0) {
    lines.push(`- ... 其余 ${remaining} 个频道已省略`);
  }
}

export function renderCleanupPreviewMessage(
  preview: ReturnType<typeof buildProjectCleanupPreview>,
): string {
  const lines = [
    '批量清理预览',
    '',
    `项目：${preview.projectName}`,
    '范围：当前项目分类下的其他空闲会话',
    '',
    '将保留：',
    `- 当前频道：<#${preview.protectedChannels.currentChannelId}>`,
  ];

  if (preview.protectedChannels.controlChannelId) {
    lines.push(`- 控制频道：<#${preview.protectedChannels.controlChannelId}>`);
  }
  if (preview.protectedChannels.historyChannelId) {
    lines.push(`- 历史归档：<#${preview.protectedChannels.historyChannelId}>`);
  }

  appendCleanupPreviewSection(lines, '将跳过（进行中）：', preview.skippedGenerating);
  appendCleanupPreviewSection(lines, '将归档：', preview.archiveCandidates);
  lines.push(
    '',
    `预计归档 ${preview.archiveCandidates.length} 个频道，跳过 ${preview.skippedGenerating.length} 个进行中的会话。`,
  );

  return lines.join('\n');
}

export function parseCodexBypass(value: string | null): boolean | undefined {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return undefined;
}

export function buildSpawnPermissionPatch(
  interaction: ChatInputCommandInteraction,
  provider: ProviderName,
): Partial<Parameters<typeof createSession>[0]> {
  if (provider === 'claude') {
    return {
      claudePermissionMode: (interaction.options.getString('claude-permissions') ||
        config.claudePermissionMode) as 'bypass' | 'normal',
    };
  }

  return {
    codexSandboxMode:
      (interaction.options.getString('codex-sandbox') as
        | 'read-only'
        | 'workspace-write'
        | 'danger-full-access'
        | null) ?? config.codexSandboxMode,
    codexApprovalPolicy:
      (interaction.options.getString('codex-approval') as
        | 'never'
        | 'on-request'
        | 'on-failure'
        | 'untrusted'
        | null) ?? config.codexApprovalPolicy,
    codexBypass: parseCodexBypass(interaction.options.getString('codex-bypass')),
    codexNetworkAccessEnabled: config.codexNetworkAccessEnabled,
    codexWebSearchMode: config.codexWebSearchMode,
  };
}

export function buildPermissionUpdatePatch(
  interaction: ChatInputCommandInteraction,
  provider: ProviderName,
): Partial<import('@workspacecord/core').ThreadSession> {
  if (provider === 'claude') {
    const claudePermissionMode = interaction.options.getString('claude-permissions') as
      | 'bypass'
      | 'normal'
      | null;
    return claudePermissionMode ? { claudePermissionMode } : {};
  }

  const patch: Partial<import('@workspacecord/core').ThreadSession> = {};
  const sandbox = interaction.options.getString('codex-sandbox') as
    | 'read-only'
    | 'workspace-write'
    | 'danger-full-access'
    | null;
  const approval = interaction.options.getString('codex-approval') as
    | 'never'
    | 'on-request'
    | 'on-failure'
    | 'untrusted'
    | null;
  const bypass = parseCodexBypass(interaction.options.getString('codex-bypass'));

  if (sandbox) patch.codexSandboxMode = sandbox;
  if (approval) patch.codexApprovalPolicy = approval;
  if (bypass !== undefined) patch.codexBypass = bypass;
  if (sandbox || approval || bypass !== undefined) {
    patch.codexNetworkAccessEnabled = true;
    patch.codexWebSearchMode = 'live';
  }
  return patch;
}

export function assertUserAllowed(interaction: ChatInputCommandInteraction): boolean {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    interaction.reply({ content: '你没有权限使用此机器人。', ephemeral: true });
    return false;
  }
  return true;
}

export function resolveProjectCategoryId(interaction: ChatInputCommandInteraction): string | null {
  const channel = interaction.channel;
  if (!channel) return null;

  if (channel.isThread()) {
    const parent = (channel as AnyThreadChannel).parent as TextChannel | null;
    return parent?.parentId ?? null;
  }

  return (channel as TextChannel).parentId ?? null;
}

export function resolveCleanupCurrentChannelId(interaction: ChatInputCommandInteraction): string | null {
  const channel = interaction.channel;
  if (!channel) return null;

  if (channel.isThread()) {
    const parent = (channel as AnyThreadChannel).parent as TextChannel | null;
    return parent?.id ?? null;
  }

  return (channel as TextChannel).id ?? null;
}

function findControlChannel(guild: Guild, categoryId: string): TextChannel | null {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.parentId === categoryId &&
      channel.name === CONTROL_CHANNEL_NAME,
  );
  return (existing as TextChannel | undefined) ?? null;
}

export async function resolveOrCreateControlChannel(
  interaction: ChatInputCommandInteraction,
  guild: Guild,
  categoryId: string,
  storedControlChannelId?: string,
): Promise<TextChannel> {
  const currentChannel = interaction.channel as TextChannel;

  if (storedControlChannelId) {
    const existing = guild.channels.cache.get(storedControlChannelId);
    if (existing?.type === ChannelType.GuildText) {
      return existing as TextChannel;
    }
  }

  const currentSession = getSessionByChannel(currentChannel.id);
  if (!currentSession) {
    projectMgr.setControlChannelId(categoryId, currentChannel.id);
    return currentChannel;
  }

  const reusable = findControlChannel(guild, categoryId);
  if (reusable) {
    projectMgr.setControlChannelId(categoryId, reusable.id);
    return reusable;
  }

  const created = await guild.channels.create({
    name: CONTROL_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: 'Use /agent spawn here to create new agent sessions',
    reason: `Project control channel created for ${interaction.user.tag}`,
  });
  projectMgr.setControlChannelId(categoryId, created.id);
  return created;
}

export { type SessionChannel };
