import {
  ChannelType,
  EmbedBuilder,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import * as projectMgr from '../project-manager.ts';
import { getSessionsByCategory, getSessionByChannel } from '../session-registry.ts';
import { executeSessionPrompt } from '../session-executor.ts';
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
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleProjectSetup(interaction: ChatInputCommandInteraction): Promise<void> {
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

  const sessions = getSessionsByCategory(categoryId);
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

async function handleProjectPersonalityClear(interaction: ChatInputCommandInteraction): Promise<void> {
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

  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'No channel context.', ephemeral: true });
    return;
  }

  const session = getSessionByChannel(channel.id);
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
  const args = argsRaw.split(',').map((item) => item.trim()).filter(Boolean);
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
