import {
  ChannelType,
  EmbedBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import * as projectMgr from '@workspacecord/engine/project-manager';
import { getSessionsByCategory, getSessionByChannel } from '@workspacecord/engine/session-registry';
import { executeSessionPrompt } from '@workspacecord/engine/session-executor';
import {
  assertUserAllowed,
  log,
  resolveProjectCategoryId,
  type SessionChannel,
} from '../command-handlers-shared.ts';

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
      await interaction.reply({ content: `未知子命令：${sub}`, ephemeral: true });
  }
}

async function handleProjectSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: '请在普通频道中执行 `/project setup`，不能在子区内执行。',
      ephemeral: true,
    });
    return;
  }

  const categoryId = (interaction.channel as TextChannel)?.parentId;
  if (!categoryId) {
    await interaction.reply({
      content:
        '此频道不在分类下，请在属于分类（代表你的项目）的频道中执行此命令。',
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
    await interaction.editReply(`绑定项目失败：${(err as Error).message}`);
    return;
  }

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
      historyInfo = `\n• 历史论坛：<#${historyForum.id}>`;
    } catch {
      historyInfo = '\n• （无法创建 #history 论坛，请手动创建）';
    }
  } else {
    historyInfo = `\n• 历史论坛：<#${project.historyChannelId}>`;
  }

  projectMgr.setControlChannelId(categoryId, interaction.channelId);
  const controlInfo = `\n• 控制频道：<#${interaction.channelId}>`;

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ 项目就绪：${project.name}`)
    .addFields(
      { name: '分类', value: `**${categoryName}**`, inline: true },
      { name: '目录', value: `\`${project.directory}\``, inline: true },
    )
    .setDescription(
      `在 <#${interaction.channelId}> 中使用 \`/agent spawn\` 创建新的 Agent 会话。${historyInfo}${controlInfo}`,
    );

  await interaction.editReply({ embeds: [embed] });
  log(`Project "${project.name}" set up by ${interaction.user.tag}`);
}

async function handleProjectInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({
      content: '无法从此频道确定项目分类。',
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

  const sessions = getSessionsByCategory(categoryId);
  const activeSessions = sessions.filter((s) => s.type === 'persistent');

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📁 项目：${project.name}`)
    .addFields(
      { name: '目录', value: `\`${project.directory}\``, inline: false },
      { name: '活跃会话', value: `${activeSessions.length}`, inline: true },
      { name: '技能', value: `${project.skills.length}`, inline: true },
      { name: 'MCP 服务器', value: `${project.mcpServers.length}`, inline: true },
    );

  if (project.historyChannelId) {
    embed.addFields({ name: '历史', value: `<#${project.historyChannelId}>`, inline: true });
  }

  if (project.controlChannelId) {
    embed.addFields({ name: '控制', value: `<#${project.controlChannelId}>`, inline: true });
  }

  if (project.personality) {
    embed.addFields({
      name: '人设',
      value: `\`\`\`\n${project.personality.slice(0, 500)}\n\`\`\``,
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleProjectPersonality(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({ content: '请先执行 `/project setup`。', ephemeral: true });
    return;
  }
  const prompt = interaction.options.getString('prompt', true);
  projectMgr.setPersonality(categoryId, prompt);
  await interaction.reply({
    content: `已为项目 **${project.name}** 设置人设。`,
    ephemeral: true,
  });
}

async function handleProjectPersonalityClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  projectMgr.clearPersonality(categoryId);
  await interaction.reply({ content: '人设已清除。', ephemeral: true });
}

async function handleProjectSkillAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({ content: '请先执行 `/project setup`。', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const prompt = interaction.options.getString('prompt', true);
  projectMgr.addSkill(categoryId, name, prompt);
  await interaction.reply({ content: `技能 **${name}** 已添加。`, ephemeral: true });
}

async function handleProjectSkillRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const removed = projectMgr.removeSkill(categoryId, name);
  await interaction.reply({
    content: removed ? `技能 **${name}** 已移除。` : `技能 **${name}** 未找到。`,
    ephemeral: true,
  });
}

async function handleProjectSkillList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const skills = projectMgr.getSkills(categoryId);
  if (skills.length === 0) {
    await interaction.reply({
      content: '未定义技能，请使用 `/project skill-add`。',
      ephemeral: true,
    });
    return;
  }
  const lines = skills
    .map((s) => `**${s.name}**: ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '…' : ''}`)
    .join('\n');
  await interaction.reply({ content: `技能列表：\n${lines}`, ephemeral: true });
}

async function handleProjectSkillRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const input = interaction.options.getString('input') || undefined;
  const prompt = projectMgr.executeSkill(categoryId, name, input);
  if (!prompt) {
    await interaction.reply({ content: `技能 **${name}** 未找到。`, ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: '无频道上下文。', ephemeral: true });
    return;
  }

  const session = getSessionByChannel(channel.id);
  if (!session) {
    await interaction.reply({
      content: '请在活跃的 Agent 会话频道中执行此命令。',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply(`正在执行技能 **${name}**...`);
  await executeSessionPrompt(session, channel as SessionChannel, prompt);
}

async function handleProjectMcpAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const project = projectMgr.getProject(categoryId);
  if (!project) {
    await interaction.reply({ content: '请先执行 `/project setup`。', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const command = interaction.options.getString('command', true);
  const argsRaw = interaction.options.getString('args') || '';
  const args = argsRaw.split(',').map((item) => item.trim()).filter(Boolean);
  await projectMgr.addMcpServer(categoryId, name, command, args);
  await interaction.reply({ content: `MCP 服务器 **${name}** 已添加。`, ephemeral: true });
}

async function handleProjectMcpRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const removed = await projectMgr.removeMcpServer(categoryId, name);
  await interaction.reply({
    content: removed ? `MCP 服务器 **${name}** 已移除。` : `MCP 服务器 **${name}** 未找到。`,
    ephemeral: true,
  });
}

async function handleProjectMcpList(interaction: ChatInputCommandInteraction): Promise<void> {
  const categoryId = resolveProjectCategoryId(interaction);
  if (!categoryId) {
    await interaction.reply({ content: '无法确定项目分类。', ephemeral: true });
    return;
  }
  const servers = projectMgr.getMcpServers(categoryId);
  if (servers.length === 0) {
    await interaction.reply({ content: '未配置 MCP 服务器。', ephemeral: true });
    return;
  }
  const lines = servers.map(
    (server) =>
      `**${server.name}** — \`${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}\``,
  );
  await interaction.reply({ content: `MCP 服务器：\n${lines.join('\n')}`, ephemeral: true });
}
