import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from '../config.ts';
import * as sessionMgr from '../thread-manager.ts';
import * as projectMgr from '../project-manager.ts';
import { archiveSession } from '../archive-manager.ts';
import { executeSessionContinue } from '../session-executor.ts';
import { makeModeButtons, resolveEffectiveClaudePermissionMode } from '../output-handler.ts';
import { createCleanupRequest } from '../agent-cleanup-request-store.ts';
import { buildProjectCleanupPreview } from '../session-housekeeping.ts';
import { formatRelative } from '../utils.ts';
import type { ProviderName, SessionMode } from '../types.ts';
import {
  assertUserAllowed,
  buildPermissionUpdatePatch,
  buildSpawnPermissionPatch,
  log,
  MODE_LABELS,
  PROVIDER_COLORS,
  PROVIDER_LABELS,
  registerStatusCardWithPanelAdapter,
  renderCleanupPreviewMessage,
  resolveCleanupCurrentChannelId,
  resolveOrCreateControlChannel,
  resolveProjectCategoryId,
  type SessionChannel,
} from '../command-handlers-shared.ts';

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
    case 'permissions':
      return handleAgentPermissions(interaction);
    case 'continue':
      return handleAgentContinue(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

export async function handleAgentSpawn(interaction: ChatInputCommandInteraction): Promise<void> {
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
  const provider = (interaction.options.getString('provider') || config.defaultProvider) as ProviderName;
  const mode = (interaction.options.getString('mode') || config.defaultMode) as SessionMode;
  const directory = interaction.options.getString('directory') || project.directory;
  const permissionPatch = buildSpawnPermissionPatch(interaction, provider);

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
      ...permissionPatch,
    });
  } catch (err: unknown) {
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
    .setDescription('等待首条消息')
    .addFields({
      name: '权限',
      value: sessionMgr.getSessionPermissionSummary(session),
      inline: false,
    });

  const statusMessage = await sessionChannel.send({
    embeds: [statusEmbed],
    components: [makeModeButtons(session.id, mode, session.claudePermissionMode)],
  });
  sessionMgr.setCurrentInteractionMessage(session.id, undefined);

  let registered = false;
  try {
    registered = await registerStatusCardWithPanelAdapter(session.id, sessionChannel, statusMessage.id);
  } catch (err: unknown) {
    log(`[panel-adapter] 状态卡注册失败，session=${session.id}，错误：${(err as Error).message}`);
  }

  if (!registered) {
    await interaction.editReply(`Failed to initialize session panel for "${label}".`);
    return;
  }
  sessionMgr.setStatusCardBinding(session.id, { messageId: statusMessage.id });
  log(`[panel-adapter] 状态卡已注册，session=${session.id}`);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ Agent Created: ${label}`)
    .addFields(
      { name: 'Channel', value: `<#${sessionChannel.id}>`, inline: true },
      { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
      { name: 'Mode', value: (MODE_LABELS?.[mode] ?? mode), inline: false },
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
  } else if (provider === 'codex') {
    embed.addFields({
      name: 'Codex 权限',
      value: sessionMgr.getSessionPermissionDetails(session),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
  log(`Agent "${label}" (${provider}) spawned by ${interaction.user.tag} in category ${categoryId}`);
}

export async function handleAgentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: 'Could not determine project category.', ephemeral: true });
    return;
  }

  const sessions = sessionMgr.getSessionsByCategory(categoryId).filter((s) => s.type === 'persistent');

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

export async function handleAgentCleanup(interaction: ChatInputCommandInteraction): Promise<void> {
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

export async function handleAgentStop(interaction: ChatInputCommandInteraction): Promise<void> {
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

export async function handleAgentEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await sessionMgr.endSession(session.id);

  if (session.type === 'persistent' && interaction.guild) {
    try {
      const ch = interaction.guild.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (ch) await ch.delete(`Ended by ${interaction.user.tag}`);
    } catch {
      /* best effort */
    }
  } else if (session.type === 'subagent' && interaction.channel?.isThread()) {
    try {
      await (interaction.channel as AnyThreadChannel).setArchived(true, `Ended by ${interaction.user.tag}`);
    } catch {
      /* best effort */
    }
  }

  await interaction.editReply('Agent session ended.').catch(() => {});
  log(`Session "${session.id}" ended by ${interaction.user.tag}`);
}

export async function handleAgentArchive(interaction: ChatInputCommandInteraction): Promise<void> {
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

export async function handleAgentMode(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const mode = interaction.options.getString('mode', true) as SessionMode;
  sessionMgr.setMode(session.id, mode);
  await interaction.reply({ content: `Mode set to **${MODE_LABELS?.[mode] ?? mode}**.`, ephemeral: true });
}

export async function handleAgentGoal(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const goal = interaction.options.getString('goal', true);
  sessionMgr.setMonitorGoal(session.id, goal);
  await interaction.reply({ content: `Monitor goal set: *${goal}*`, ephemeral: true });
}

export async function handleAgentPersona(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const persona = interaction.options.getString('name') || undefined;
  sessionMgr.setAgentPersona(session.id, persona === 'general' ? undefined : persona);
  await interaction.reply({ content: `Persona set to **${persona || 'general'}**.`, ephemeral: true });
}

export async function handleAgentVerbose(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const newVerbose = !session.verbose;
  sessionMgr.setVerbose(session.id, newVerbose);
  await interaction.reply({ content: `Verbose mode ${newVerbose ? 'enabled' : 'disabled'}.`, ephemeral: true });
}

export async function handleAgentModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }
  const model = interaction.options.getString('model', true);
  sessionMgr.setModel(session.id, model);
  await interaction.reply({ content: `Model set to \`${model}\`.`, ephemeral: true });
}

export async function handleAgentPermissions(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessionMgr.getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No active session in this channel.', ephemeral: true });
    return;
  }

  const patch = buildPermissionUpdatePatch(interaction, session.provider);
  if (Object.keys(patch).length === 0) {
    await interaction.reply({ content: '未提供任何权限变更。', ephemeral: true });
    return;
  }

  await sessionMgr.updateSessionPermissions(session.id, patch);
  const refreshed = sessionMgr.getSession(session.id) ?? { ...session, ...patch };
  const timing = session.isGenerating ? '已保存，将在下一轮生效。' : '已更新并立即生效。';
  await interaction.reply({
    content: `${timing}\n当前权限：${sessionMgr.getSessionPermissionDetails(refreshed as never)}`,
    ephemeral: true,
  });
}

export async function handleAgentContinue(interaction: ChatInputCommandInteraction): Promise<void> {
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
