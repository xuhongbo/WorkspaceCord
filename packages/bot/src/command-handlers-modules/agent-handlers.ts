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
import { config, formatRelative } from '@workspacecord/core';
import { createSession, getSessionByChannel, getSessionsByCategory, setMode, setMonitorGoal, setAgentPersona, setVerbose, setModel, setStatusCardBinding, setCurrentInteractionMessage, abortSession, endSession, updateSessionPermissions, getSessionPermissionSummary, getSessionPermissionDetails } from '@workspacecord/engine/session-registry';
import { getSessionView } from '@workspacecord/engine/session-context';
import * as projectMgr from '@workspacecord/engine/project-manager';
import { archiveSession } from '../archive-manager.ts';
import { executeSessionContinue } from '@workspacecord/engine/session-executor';
import { makeModeButtons, resolveEffectiveClaudePermissionMode } from '../output-handler.ts';
import { createCleanupRequest } from '@workspacecord/engine/agent-cleanup-request-store';
import { buildProjectCleanupPreview } from '../session-housekeeping.ts';
import type { ProviderName, SessionMode } from '@workspacecord/core';
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
      await interaction.reply({ content: `未知子命令：${sub}`, ephemeral: true });
  }
}

export async function handleAgentSpawn(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: '请在项目频道中执行 `/agent spawn`，不能在子区内执行。',
      ephemeral: true,
    });
    return;
  }

  const categoryId = (interaction.channel as TextChannel)?.parentId;
  if (!categoryId) {
    await interaction.reply({
      content: '此频道不在分类下，请先执行 `/project setup`。',
      ephemeral: true,
    });
    return;
  }

  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({
      content: '此分类未设置项目，请先执行 `/project setup`。',
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
      `新会话只能在项目控制频道 <#${controlChannel.id}> 中创建，请在那里执行 \`/agent spawn\`。`,
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
    await interaction.editReply(`创建会话频道失败：${(err as Error).message}`);
    return;
  }

  let session;
  try {
    session = await createSession({
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
    await interaction.editReply(`创建会话失败：${(err as Error).message}`);
    return;
  }

  if (mode !== 'auto') {
    setMode(session.id, mode);
  }

  const statusEmbed = new EmbedBuilder()
    .setColor(PROVIDER_COLORS[provider])
    .setTitle('💤 待命')
    .setDescription('等待首条消息')
    .addFields({
      name: '权限',
      value: getSessionPermissionSummary(session),
      inline: false,
    });

  const statusMessage = await sessionChannel.send({
    embeds: [statusEmbed],
    components: [makeModeButtons(session.id, mode, session.claudePermissionMode)],
  });
  setCurrentInteractionMessage(session.id, undefined);

  let registered = false;
  try {
    registered = await registerStatusCardWithPanelAdapter(session.id, sessionChannel, statusMessage.id);
  } catch (err: unknown) {
    log(`[panel-adapter] 状态卡注册失败，session=${session.id}，错误：${(err as Error).message}`);
  }

  if (!registered) {
    await interaction.editReply(`初始化会话面板失败："${label}"。`);
    return;
  }
  setStatusCardBinding(session.id, { messageId: statusMessage.id });
  log(`[panel-adapter] 状态卡已注册，session=${session.id}`);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ Agent 已创建：${label}`)
    .addFields(
      { name: '频道', value: `<#${sessionChannel.id}>`, inline: true },
      { name: '提供商', value: PROVIDER_LABELS[provider], inline: true },
      { name: '模式', value: (MODE_LABELS?.[mode] ?? mode), inline: false },
      { name: '目录', value: `\`${session.directory}\``, inline: false },
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
      value: getSessionPermissionDetails(session),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
  log(`Agent "${label}" (${provider}) spawned by ${interaction.user.tag} in category ${categoryId}`);
}

export async function handleAgentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }

  const sessions = getSessionsByCategory(categoryId).filter((s) => s.type === 'persistent');

  if (sessions.length === 0) {
    await interaction.reply({
      content: '此项目没有活跃的 Agent 会话。',
      ephemeral: true,
    });
    return;
  }

  const lines = sessions.map((s) => {
    const status = s.isGenerating ? '🔄 执行中' : '💤 空闲';
    return `${status} | \`${s.agentLabel}\` | ${s.provider} | <#${s.channelId}> | ${formatRelative(s.lastActivity)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Agent 会话（${sessions.length}）`)
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleAgentCleanup(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }

  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({
      content: '此分类未设置项目，请先执行 `/project setup`。',
      ephemeral: true,
    });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: '需要服务器上下文。', ephemeral: true });
    return;
  }

  const currentChannelId = resolveCleanupCurrentChannelId(interaction);
  if (!currentChannelId) {
    await interaction.reply({ content: '无法确定当前频道。', ephemeral: true });
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
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: '此频道没有活跃的会话，请在 Agent 会话频道中执行。',
      ephemeral: true,
    });
    return;
  }
  const stopped = abortSession(session.id);
  await interaction.reply({
    content: stopped ? '已停止生成。' : 'Agent 未在执行中。',
    ephemeral: true,
  });
}

export async function handleAgentEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await endSession(session.id);

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

  await interaction.editReply('Agent 会话已结束。').catch(() => {});
  log(`Session "${session.id}" ended by ${interaction.user.tag}`);
}

export async function handleAgentArchive(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  if (session.type !== 'persistent') {
    await interaction.reply({
      content: '只有持久会话可以归档，子任务请使用 `/agent end`。',
      ephemeral: true,
    });
    return;
  }
  if (!interaction.guild) {
    await interaction.reply({ content: '需要服务器上下文。', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    await archiveSession(session, interaction.guild);
    await interaction.editReply('会话已归档至 #history，频道已删除。').catch(() => {});
    log(`Session "${session.id}" archived by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`归档失败：${(err as Error).message}`);
  }
}

export async function handleAgentMode(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  const mode = interaction.options.getString('mode', true) as SessionMode;
  setMode(session.id, mode);
  await interaction.reply({ content: `模式已设为 **${MODE_LABELS?.[mode] ?? mode}**。`, ephemeral: true });
}

export async function handleAgentGoal(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  const goal = interaction.options.getString('goal', true);
  setMonitorGoal(session.id, goal);
  await interaction.reply({ content: `监控目标已设为：*${goal}*`, ephemeral: true });
}

export async function handleAgentPersona(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  const persona = interaction.options.getString('name') || undefined;
  setAgentPersona(session.id, persona === 'general' ? undefined : persona);
  await interaction.reply({ content: `人设已设为 **${persona || 'general'}**。`, ephemeral: true });
}

export async function handleAgentVerbose(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  const newVerbose = !session.verbose;
  setVerbose(session.id, newVerbose);
  await interaction.reply({ content: `详细模式已${newVerbose ? '开启' : '关闭'}。`, ephemeral: true });
}

export async function handleAgentModel(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  const model = interaction.options.getString('model', true);
  setModel(session.id, model);
  await interaction.reply({ content: `模型已设为 \`${model}\`。`, ephemeral: true });
}

export async function handleAgentPermissions(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }

  const patch = buildPermissionUpdatePatch(interaction, session.provider);
  if (Object.keys(patch).length === 0) {
    await interaction.reply({ content: '未提供任何权限变更。', ephemeral: true });
    return;
  }

  await updateSessionPermissions(session.id, patch);
  const refreshed = getSessionView(session.id) ?? { ...session, ...patch };
  const timing = session.isGenerating ? '已保存，将在下一轮生效。' : '已更新并立即生效。';
  await interaction.reply({
    content: `${timing}\n当前权限：${getSessionPermissionDetails(refreshed as never)}`,
    ephemeral: true,
  });
}

export async function handleAgentContinue(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: '无频道上下文。', ephemeral: true });
    return;
  }
  const session = getSessionByChannel(channel.id);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }
  if (session.isGenerating) {
    await interaction.reply({ content: 'Agent 正在执行中。', ephemeral: true });
    return;
  }
  await interaction.deferReply();
  await interaction.editReply('继续中...');
  await executeSessionContinue(session, channel as SessionChannel);
}
