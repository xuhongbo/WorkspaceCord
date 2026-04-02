import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
  type CategoryChannel,
  type AnyThreadChannel,
  type Guild,
} from 'discord.js';
import { config } from './config.ts';
import * as sessionMgr from './thread-manager.ts';
import * as projectMgr from './project-manager.ts';
import { spawnSubagent, getSubagents } from './subagent-manager.ts';
import { archiveSession } from './archive-manager.ts';
import { executeSessionPrompt, executeSessionContinue } from './session-executor.ts';
import { makeModeButtons, resolveEffectiveClaudePermissionMode } from './output-handler.ts';
import * as panelAdapter from './panel-adapter.ts';
import { executeShellCommand, listProcesses, killProcess } from './shell-handler.ts';
import { createCleanupRequest } from './agent-cleanup-request-store.ts';
import { buildProjectCleanupPreview } from './session-housekeeping.ts';
import { isUserAllowed, resolvePath, formatUptime, formatRelative } from './utils.ts';
import type { ProviderName, SessionMode } from './types.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

let logFn: (msg: string) => void = console.log;
export function setLogger(fn: (msg: string) => void): void {
  logFn = fn;
}
function log(msg: string): void {
  logFn(msg);
}

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
};

const PROVIDER_COLORS: Record<ProviderName, number> = {
  claude: 0x3498db,
  codex: 0x10a37f,
};

const MODE_LABELS: Record<SessionMode, string> = {
  auto: '⚡ Auto — full autonomy',
  plan: '📋 Plan — plans before changes',
  normal: '🛡️ Normal — asks before destructive ops',
  monitor: '🧠 Monitor — steers until complete',
};

const CLEANUP_PREVIEW_LIST_LIMIT = 10;
const CLEANUP_PREVIEW_LABEL_LIMIT = 120;

type ExistingStatusCardRegistrar = (
  sessionId: string,
  channel: TextChannel,
  statusCardMessageId: string,
) => Promise<void>;

async function registerStatusCardWithPanelAdapter(
  sessionId: string,
  channel: TextChannel,
  statusCardMessageId: string,
): Promise<boolean> {
  const adapter = panelAdapter as unknown as {
    registerExistingStatusCard?: ExistingStatusCardRegistrar;
  };

  if (typeof adapter.registerExistingStatusCard !== 'function') {
    log(
      `[panel-adapter] registerExistingStatusCard 未暴露，session=${sessionId}`,
    );
    return false;
  }

  await adapter.registerExistingStatusCard(sessionId, channel, statusCardMessageId);
  return true;
}

const CONTROL_CHANNEL_NAME = 'control';

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

function renderCleanupPreviewMessage(preview: ReturnType<typeof buildProjectCleanupPreview>): string {
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

function assertUserAllowed(interaction: ChatInputCommandInteraction): boolean {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    interaction.reply({ content: 'You are not authorized to use this bot.', ephemeral: true });
    return false;
  }
  return true;
}

/**
 * Resolve the project's Category ID from the current interaction channel.
 * Works from: a session TextChannel, a subagent Thread, or a plain Category channel.
 */
function resolveProjectCategoryId(interaction: ChatInputCommandInteraction): string | null {
  const channel = interaction.channel;
  if (!channel) return null;

  if (channel.isThread()) {
    // Subagent thread → parent is a TextChannel → grandparent is the category
    const parent = (channel as AnyThreadChannel).parent as TextChannel | null;
    return parent?.parentId ?? null;
  }

  // TextChannel → parentId is the category
  return (channel as TextChannel).parentId ?? null;
}

function resolveCleanupCurrentChannelId(interaction: ChatInputCommandInteraction): string | null {
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

async function resolveOrCreateControlChannel(
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

  const currentSession = sessionMgr.getSessionByChannel(currentChannel.id);
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

// ── /project ──────────────────────────────────────────────────────────────────

export async function handleProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'setup':
      return handleProjectSetup(interaction);
    case 'info':
      return handleProjectInfo(interaction);
    case 'personality':
      return handleProjectPersonality(interaction);
    case 'personality-clear':
      return handleProjectPersonalityClear(interaction);
    case 'skill-add':
      return handleProjectSkillAdd(interaction);
    case 'skill-remove':
      return handleProjectSkillRemove(interaction);
    case 'skill-list':
      return handleProjectSkillList(interaction);
    case 'skill-run':
      return handleProjectSkillRun(interaction);
    case 'mcp-add':
      return handleProjectMcpAdd(interaction);
    case 'mcp-remove':
      return handleProjectMcpRemove(interaction);
    case 'mcp-list':
      return handleProjectMcpList(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleProjectSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  // Must be in a TextChannel (not a thread)
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: 'Run `/project setup` in a regular channel, not inside a thread.',
      ephemeral: true,
    });
    return;
  }

  const categoryId = (interaction.channel as TextChannel)?.parentId;
  if (!categoryId) {
    await interaction.reply({
      content:
        'This channel is not under a Category. Please run this command in a channel that belongs to a Category (which represents your project).',
      ephemeral: true,
    });
    return;
  }

  const projectName = interaction.options.getString('project', true);

  await interaction.deferReply();

  const guild = interaction.guild!;
  const category = guild.channels.cache.get(categoryId) as CategoryChannel | undefined;
  const categoryName = category?.name || 'unknown';
  let project;
  try {
    project = await projectMgr.bindMountedProjectToCategory(projectName, categoryId, categoryName);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to bind project: ${(err as Error).message}`);
    return;
  }

  // Ensure #history Forum channel exists
  let historyInfo = '';
  if (!project.historyChannelId) {
    try {
      const historyForum = await guild.channels.create({
        name: 'history',
        type: ChannelType.GuildForum,
        parent: categoryId,
        topic: 'Archived agent sessions for this project',
        reason: 'Created by workspacecord for session archiving',
      });
      projectMgr.setHistoryChannelId(categoryId, historyForum.id);
      historyInfo = `\n• History forum: <#${historyForum.id}>`;
    } catch {
      historyInfo = '\n• (Could not create #history forum — create it manually if needed)';
    }
  } else {
    historyInfo = `\n• History forum: <#${project.historyChannelId}>`;
  }

  projectMgr.setControlChannelId(categoryId, interaction.channelId);
  const controlInfo = `\n• Control channel: <#${interaction.channelId}>`;

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ Project Ready: ${project.name}`)
    .addFields(
      { name: 'Category', value: `**${categoryName}**`, inline: true },
      { name: 'Directory', value: `\`${project.directory}\``, inline: true },
    )
    .setDescription(
      `Use \`/agent spawn\` in <#${interaction.channelId}> to create new agent sessions.${historyInfo}${controlInfo}`,
    );

  await interaction.editReply({ embeds: [embed] });
  log(`Project "${project.name}" set up by ${interaction.user.tag}`);
}

async function handleProjectInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({
      content: 'Could not determine project category from this channel.',
      ephemeral: true,
    });
    return;
  }

  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({
      content: 'No project set up for this category. Run `/project setup` first.',
      ephemeral: true,
    });
    return;
  }

  const sessions = sessionMgr.getSessionsByCategory(categoryId);
  const activeSessions = sessions.filter((s) => s.type === 'persistent');

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📁 Project: ${project.name}`)
    .addFields(
      { name: 'Directory', value: `\`${project.directory}\``, inline: false },
      { name: 'Active Sessions', value: `${activeSessions.length}`, inline: true },
      { name: 'Skills', value: `${project.skills.length}`, inline: true },
      { name: 'MCP Servers', value: `${project.mcpServers.length}`, inline: true },
    );

  if (project.historyChannelId) {
    embed.addFields({ name: 'History', value: `<#${project.historyChannelId}>`, inline: true });
  }

  if (project.controlChannelId) {
    embed.addFields({ name: 'Control', value: `<#${project.controlChannelId}>`, inline: true });
  }

  if (project.personality) {
    embed.addFields({
      name: 'Personality',
      value: `\`\`\`\n${project.personality.slice(0, 500)}\n\`\`\``,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleProjectPersonality(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({ content: 'Run `/project setup` first.', ephemeral: true });
    return;
  }
  const prompt = interaction.options.getString('prompt', true);
  projectMgr.setPersonality(categoryId, prompt);
  await interaction.reply({
    content: `Personality set for project **${project.name}**.`,
    ephemeral: true,
  });
}

async function handleProjectPersonalityClear(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  projectMgr.clearPersonality(categoryId);
  await interaction.reply({ content: 'Personality cleared.', ephemeral: true });
}

async function handleProjectSkillAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({ content: 'Run `/project setup` first.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const prompt = interaction.options.getString('prompt', true);
  projectMgr.addSkill(categoryId, name, prompt);
  await interaction.reply({ content: `Skill **${name}** added.`, ephemeral: true });
}

async function handleProjectSkillRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const removed = projectMgr.removeSkill(categoryId, name);
  await interaction.reply({
    content: removed ? `Skill **${name}** removed.` : `Skill **${name}** not found.`,
    ephemeral: true,
  });
}

async function handleProjectSkillList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const skills = projectMgr.getSkills(categoryId);
  if (skills.length === 0) {
    await interaction.reply({
      content: 'No skills defined. Use `/project skill-add`.',
      ephemeral: true,
    });
    return;
  }
  const lines = skills
    .map((s) => `**${s.name}**: ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '…' : ''}`)
    .join('\n');
  await interaction.reply({ content: `Skills:\n${lines}`, ephemeral: true });
}

async function handleProjectSkillRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const input = interaction.options.getString('input') || undefined;
  const prompt = projectMgr.executeSkill(categoryId, name, input);
  if (!prompt) {
    await interaction.reply({ content: `Skill **${name}** not found.`, ephemeral: true });
    return;
  }

  // Must be run from a session channel (or subagent thread)
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'No channel context.', ephemeral: true });
    return;
  }

  const session = sessionMgr.getSessionByChannel(channel.id);
  if (!session) {
    await interaction.reply({
      content: 'Run this command inside an active agent session channel.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply(`Running skill **${name}**...`);
  await executeSessionPrompt(session, channel as SessionChannel, prompt);
}

async function handleProjectMcpAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({ content: 'Run `/project setup` first.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const command = interaction.options.getString('command', true);
  const argsRaw = interaction.options.getString('args') || '';
  const args = argsRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  await projectMgr.addMcpServer(categoryId, name, command, args);
  await interaction.reply({ content: `MCP server **${name}** added.`, ephemeral: true });
}

async function handleProjectMcpRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const removed = await projectMgr.removeMcpServer(categoryId, name);
  await interaction.reply({
    content: removed ? `MCP server **${name}** removed.` : `MCP server **${name}** not found.`,
    ephemeral: true,
  });
}

async function handleProjectMcpList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }
  const servers = projectMgr.getMcpServers(categoryId);
  if (servers.length === 0) {
    await interaction.reply({ content: 'No MCP servers configured.', ephemeral: true });
    return;
  }
  const lines = servers.map(
    (server) =>
      `**${server.name}** — \`${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}\``,
  );
  await interaction.reply({ content: `MCP servers:\n${lines.join('\n')}`, ephemeral: true });
}

// ── /agent ────────────────────────────────────────────────────────────────────

export async function handleAgent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'spawn':
      return handleAgentSpawn(interaction);
    case 'list':
      return handleAgentList(interaction);
    case 'cleanup':
      return handleAgentCleanup(interaction);
    case 'stop':
      return handleAgentStop(interaction);
    case 'end':
      return handleAgentEnd(interaction);
    case 'archive':
      return handleAgentArchive(interaction);
    case 'mode':
      return handleAgentMode(interaction);
    case 'goal':
      return handleAgentGoal(interaction);
    case 'persona':
      return handleAgentPersona(interaction);
    case 'verbose':
      return handleAgentVerbose(interaction);
    case 'model':
      return handleAgentModel(interaction);
    case 'continue':
      return handleAgentContinue(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleAgentSpawn(interaction: ChatInputCommandInteraction): Promise<void> {
  // Must be in a TextChannel (not inside a thread)
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: 'Run `/agent spawn` in a project channel, not inside a thread.',
      ephemeral: true,
    });
    return;
  }

  const categoryId = (interaction.channel as TextChannel)?.parentId;
  if (!categoryId) {
    await interaction.reply({
      content: 'This channel is not under a Category. Run `/project setup` first.',
      ephemeral: true,
    });
    return;
  }

  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({
      content: 'No project set up for this category. Run `/project setup` first.',
      ephemeral: true,
    });
    return;
  }

  const label = interaction.options.getString('label', true);
  const provider = (interaction.options.getString('provider') ||
    config.defaultProvider) as ProviderName;
  const mode = (interaction.options.getString('mode') || config.defaultMode) as SessionMode;
  const claudePermissionMode = (interaction.options.getString('claude-permissions') ||
    config.claudePermissionMode) as 'bypass' | 'normal';
  const directory = interaction.options.getString('directory') || project.directory;

  await interaction.deferReply();

  const guild = interaction.guild!;
  const controlChannel = await resolveOrCreateControlChannel(
    interaction,
    guild,
    categoryId,
    project.controlChannelId,
  );

  if (interaction.channelId !== controlChannel.id) {
    await interaction.editReply(
      `New agent sessions can only be spawned from the project control channel: <#${controlChannel.id}>. Please run \`/agent spawn\` there.`,
    );
    return;
  }

  // Create a new TextChannel under the same category
  const channelName = `${provider}-${label}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 100);
  let sessionChannel: TextChannel;
  try {
    sessionChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `[${PROVIDER_LABELS[provider]}] ${label}`,
      reason: `Agent session spawned by ${interaction.user.tag}`,
    });
  } catch (err: unknown) {
    await interaction.editReply(`Failed to create session channel: ${(err as Error).message}`);
    return;
  }

  // Create session record
  let session;
  try {
    session = await sessionMgr.createSession({
      channelId: sessionChannel.id,
      categoryId,
      projectName: project.name,
      agentLabel: label,
      provider,
      directory,
      type: 'persistent',
      mode,
      claudePermissionMode: provider === 'claude' ? claudePermissionMode : undefined,
    });
  } catch (err: unknown) {
    // Clean up channel if session creation fails
    await sessionChannel.delete('Session creation failed').catch(() => {});
    await interaction.editReply(`Failed to create session: ${(err as Error).message}`);
    return;
  }

  if (mode !== 'auto') {
    sessionMgr.setMode(session.id, mode);
  }

  const statusEmbed = new EmbedBuilder()
    .setColor(PROVIDER_COLORS[provider])
    .setTitle('💤 待命')
    .setDescription('等待首条消息');

  const statusMessage = await sessionChannel.send({
    embeds: [statusEmbed],
    components: [makeModeButtons(session.id, mode, session.claudePermissionMode)],
  });
  sessionMgr.setCurrentInteractionMessage(session.id, undefined);

  let registered = false;
  try {
    registered = await registerStatusCardWithPanelAdapter(session.id, sessionChannel, statusMessage.id);
  } catch (err: unknown) {
    log(
      `[panel-adapter] 状态卡注册失败，session=${session.id}，错误：${(err as Error).message}`,
    );
  }

  if (!registered) {
    await interaction.editReply(
      `Failed to initialize session panel for "${label}".`,
    );
    return;
  }
  sessionMgr.setStatusCardBinding(session.id, {
    messageId: statusMessage.id,
  });
  log(`[panel-adapter] 状态卡已注册，session=${session.id}`);

  // Reply to original command
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ Agent Created: ${label}`)
    .addFields(
      { name: 'Channel', value: `<#${sessionChannel.id}>`, inline: true },
      { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
      { name: 'Mode', value: MODE_LABELS[mode], inline: false },
      { name: 'Directory', value: `\`${session.directory}\``, inline: false },
    );

  if (provider === 'claude' && session.claudePermissionMode) {
    const effectiveClaudePermissionMode = resolveEffectiveClaudePermissionMode(
      mode,
      session.claudePermissionMode,
    );
    const permLabel =
      effectiveClaudePermissionMode === 'bypass'
        ? '⚡ 绕过权限（完全自主）'
        : '🛡️ 普通权限（需要确认）';
    embed.addFields({ name: 'Claude 权限', value: permLabel, inline: true });
  }

  await interaction.editReply({ embeds: [embed] });
  log(
    `Agent "${label}" (${provider}) spawned by ${interaction.user.tag} in category ${categoryId}`,
  );
}

async function handleAgentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }

  const sessions = sessionMgr
    .getSessionsByCategory(categoryId)
    .filter((s) => s.type === 'persistent');

  if (sessions.length === 0) {
    await interaction.reply({
      content: 'No active agent sessions in this project.',
      ephemeral: true,
    });
    return;
  }

  const lines = sessions.map((s) => {
    const status = s.isGenerating ? '🔄 Generating' : '💤 Idle';
    return `${status} | \`${s.agentLabel}\` | ${s.provider} | <#${s.channelId}> | ${formatRelative(s.lastActivity)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Agent Sessions (${sessions.length})`)
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAgentCleanup(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }

  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({
      content: 'No project set up for this category. Run `/project setup` first.',
      ephemeral: true,
    });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: 'Guild context required.', ephemeral: true });
    return;
  }

  const currentChannelId = resolveCleanupCurrentChannelId(interaction);
  if (!currentChannelId) {
    await interaction.reply({ content: 'Could not determine current channel.', ephemeral: true });
    return;
  }

  const preview = buildProjectCleanupPreview({
    categoryId,
    currentChannelId,
    controlChannelId: project.controlChannelId,
    historyChannelId: project.historyChannelId,
    projectName: project.name,
  });

  if (preview.archiveCandidates.length === 0) {
    await interaction.reply({ content: '没有可清理的空闲会话', ephemeral: true });
    return;
  }

  const request = createCleanupRequest({
    userId: interaction.user.id,
    guildId: interaction.guild.id,
    categoryId,
    currentChannelId,
    candidateSessionIds: preview.archiveCandidates.map((session) => session.id),
  });

  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`cleanup:confirm:${request.id}`)
        .setLabel('确认归档')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`cleanup:cancel:${request.id}`)
        .setLabel('取消')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  await interaction.reply({
    content: renderCleanupPreviewMessage(preview),
    components,
    ephemeral: true,
  });
}

async function handleAgentStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: 'No active session in this channel. Run this inside an agent session channel.',
      ephemeral: true,
    });
    return;
  }
  const stopped = sessionMgr.abortSession(session.id);
  await interaction.reply({
    content: stopped ? 'Generation stopped.' : 'Agent was not generating.',
    ephemeral: true,
  });
}

async function handleAgentEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await sessionMgr.endSession(session.id);

  // For persistent sessions, delete the channel; for subagents, archive the thread
  if (session.type === 'persistent' && interaction.guild) {
    try {
      const ch = interaction.guild.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (ch) await ch.delete(`Ended by ${interaction.user.tag}`);
    } catch {
      /* best effort */
    }
  } else if (session.type === 'subagent' && interaction.channel?.isThread()) {
    try {
      await (interaction.channel as AnyThreadChannel).setArchived(
        true,
        `Ended by ${interaction.user.tag}`,
      );
    } catch {
      /* best effort */
    }
  }

  await interaction.editReply('Agent session ended.').catch(() => {});
  log(`Session "${session.id}" ended by ${interaction.user.tag}`);
}

async function handleAgentArchive(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  if (session.type !== 'persistent') {
    await interaction.reply({
      content: 'Only persistent sessions can be archived. Use `/agent end` for subagents.',
      ephemeral: true,
    });
    return;
  }
  if (!interaction.guild) {
    await interaction.reply({ content: 'Guild context required.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    await archiveSession(session, interaction.guild);
    await interaction.editReply('Session archived to #history. Channel deleted.').catch(() => {});
    log(`Session "${session.id}" archived by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Archive failed: ${(err as Error).message}`);
  }
}

async function handleAgentMode(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const mode = interaction.options.getString('mode', true) as SessionMode;
  sessionMgr.setMode(session.id, mode);
  await interaction.reply({ content: `Mode set to **${MODE_LABELS[mode]}**.`, ephemeral: true });
}

async function handleAgentGoal(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const goal = interaction.options.getString('goal', true);
  sessionMgr.setMonitorGoal(session.id, goal);
  await interaction.reply({ content: `Monitor goal set: *${goal}*`, ephemeral: true });
}

async function handleAgentPersona(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const persona = interaction.options.getString('name') || undefined;
  sessionMgr.setAgentPersona(session.id, persona === 'general' ? undefined : persona);
  await interaction.reply({
    content: `Persona set to **${persona || 'general'}**.`,
    ephemeral: true,
  });
}

async function handleAgentVerbose(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const newVerbose = !session.verbose;
  sessionMgr.setVerbose(session.id, newVerbose);
  await interaction.reply({
    content: `Verbose mode ${newVerbose ? 'enabled' : 'disabled'}.`,
    ephemeral: true,
  });
}

async function handleAgentModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const model = interaction.options.getString('model', true);
  sessionMgr.setModel(session.id, model);
  await interaction.reply({ content: `Model set to \`${model}\`.`, ephemeral: true });
}

async function handleAgentContinue(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'No channel context.', ephemeral: true });
    return;
  }
  const session = sessionMgr.getSessionByChannel(channel.id);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  if (session.isGenerating) {
    await interaction.reply({ content: 'Agent is already generating.', ephemeral: true });
    return;
  }
  await interaction.deferReply();
  await interaction.editReply('Continuing...');
  await executeSessionContinue(session, channel as SessionChannel);
}

// ── /subagent ─────────────────────────────────────────────────────────────────

export async function handleSubagent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'run':
      return handleSubagentRun(interaction);
    case 'list':
      return handleSubagentList(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleSubagentRun(interaction: ChatInputCommandInteraction): Promise<void> {
  // Must be in a session TextChannel (not already a thread)
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: 'Run `/subagent run` in an agent session channel, not inside a thread.',
      ephemeral: true,
    });
    return;
  }

  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: 'No active session in this channel. You must be in an agent session channel.',
      ephemeral: true,
    });
    return;
  }

  const label = interaction.options.getString('label', true);
  const provider = (interaction.options.getString('provider') || session.provider) as ProviderName;

  await interaction.deferReply();

  const guild = interaction.guild!;
  const sessionChannel = guild.channels.cache.get(session.channelId) as TextChannel | undefined;
  if (!sessionChannel) {
    await interaction.editReply('Could not find session channel.');
    return;
  }

  try {
    const subSession = await spawnSubagent(session, label, provider, sessionChannel);
    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle(`🤖 Subagent Spawned: ${label}`)
      .addFields(
        { name: 'Thread', value: `<#${subSession.channelId}>`, inline: true },
        { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
        { name: 'Depth', value: `${subSession.subagentDepth}`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });
    log(`Subagent "${label}" spawned by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to spawn subagent: ${(err as Error).message}`);
  }
}

async function handleSubagentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }

  const subagents = getSubagents(session);
  if (subagents.length === 0) {
    await interaction.reply({ content: 'No active subagents for this session.', ephemeral: true });
    return;
  }

  const lines = subagents.map((s) => {
    const status = s.isGenerating ? '🔄' : '💤';
    return `${status} \`${s.agentLabel}\` | <#${s.channelId}> | depth: ${s.subagentDepth}`;
  });

  await interaction.reply({ content: `Active subagents:\n${lines.join('\n')}`, ephemeral: true });
}

// ── /shell ────────────────────────────────────────────────────────────────────

export async function handleShell(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!config.shellEnabled) {
    await interaction.reply({
      content:
        'Shell execution is disabled. Enable it with `workspacecord config set SHELL_ENABLED true` and set SHELL_ALLOWED_USERS.',
      ephemeral: true,
    });
    return;
  }
  if (!assertUserAllowed(interaction)) return;
  const allowedByShellList =
    config.shellAllowedUsers.length === 0 || config.shellAllowedUsers.includes(interaction.user.id);
  if (!allowedByShellList) {
    await interaction.reply({
      content: 'You are not authorized for shell access.',
      ephemeral: true,
    });
    return;
  }
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'run':
      return handleShellRun(interaction);
    case 'processes':
      return handleShellProcesses(interaction);
    case 'kill':
      return handleShellKill(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleShellRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = interaction.options.getString('command', true);
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'No channel context.', ephemeral: true });
    return;
  }

  // Resolve working directory from session or project
  let cwd = process.cwd();
  const session = sessionMgr.getSessionByChannel(channel.id);
  if (session) {
    cwd = session.directory;
  } else {
    const categoryId = resolveProjectCategoryId(interaction);
    if (categoryId) {
      const project = projectMgr.getProject(categoryId);
      if (project) cwd = project.directory;
    }
  }

  await interaction.deferReply();
  await interaction.editReply(`Running: \`${command}\``);

  await executeShellCommand(command, cwd, channel as SessionChannel);
}

async function handleShellProcesses(interaction: ChatInputCommandInteraction): Promise<void> {
  const procs = listProcesses();
  if (procs.length === 0) {
    await interaction.reply({ content: 'No running shell processes.', ephemeral: true });
    return;
  }
  const lines = procs.map(
    (p) => `**PID ${p.pid}** — \`${p.command}\` (${formatUptime(p.startedAt)})`,
  );
  await interaction.reply({ content: `Running processes:\n${lines.join('\n')}`, ephemeral: true });
}

async function handleShellKill(interaction: ChatInputCommandInteraction): Promise<void> {
  const pid = interaction.options.getInteger('pid', true);
  const killed = killProcess(pid);
  await interaction.reply({
    content: killed ? `Process ${pid} killed.` : `Process ${pid} not found.`,
    ephemeral: true,
  });
}

// ── 快捷命令处理器 ────────────────────────────────────────────────────

export async function handleSpawnShortcut(interaction: ChatInputCommandInteraction): Promise<void> {
  // 复用 handleAgentSpawn 的逻辑
  await handleAgentSpawn(interaction);
}

export async function handleStopShortcut(interaction: ChatInputCommandInteraction): Promise<void> {
  // 复用 handleAgentStop 的逻辑
  await handleAgentStop(interaction);
}

export async function handleEndShortcut(interaction: ChatInputCommandInteraction): Promise<void> {
  // 复用 handleAgentEnd 的逻辑
  await handleAgentEnd(interaction);
}

export async function handleRunShortcut(interaction: ChatInputCommandInteraction): Promise<void> {
  // 复用 handleSubagentRun 的逻辑
  await handleSubagentRun(interaction);
}
