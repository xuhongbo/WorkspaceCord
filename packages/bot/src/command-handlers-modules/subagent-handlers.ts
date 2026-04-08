import { EmbedBuilder, type ChatInputCommandInteraction, type TextChannel } from 'discord.js';
import { getSessionByChannel } from '@workspacecord/engine/session-registry';
import { spawnSubagent, getSubagents } from '../subagent-manager.ts';
import type { ProviderName } from '@workspacecord/core';
import { assertUserAllowed, log, PROVIDER_LABELS } from '../command-handlers-shared.ts';

export async function handleSubagent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'run':
      return handleSubagentRun(interaction);
    case 'list':
      return handleSubagentList(interaction);
    default:
      await interaction.reply({ content: `未知子命令：${sub}`, ephemeral: true });
  }
}

export async function handleSubagentRun(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: '请在 Agent 会话频道中执行 `/subagent run`，不能在子区内执行。',
      ephemeral: true,
    });
    return;
  }

  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({
      content: '此频道没有活跃的会话，请在 Agent 会话频道中执行。',
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
    await interaction.editReply('找不到会话频道。');
    return;
  }

  try {
    const subSession = await spawnSubagent(session, label, provider, sessionChannel);
    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle(`🤖 子任务已创建：${label}`)
      .addFields(
        { name: '子区', value: `<#${subSession.channelId}>`, inline: true },
        { name: '提供商', value: PROVIDER_LABELS[provider], inline: true },
        { name: '嵌套深度', value: `${subSession.subagentDepth}`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });
    log(`Subagent "${label}" spawned by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`创建子任务失败：${(err as Error).message}`);
  }
}

async function handleSubagentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = getSessionByChannel(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: '此频道没有活跃的会话。', ephemeral: true });
    return;
  }

  const subagents = getSubagents(session);
  if (subagents.length === 0) {
    await interaction.reply({ content: '当前会话没有活跃的子任务。', ephemeral: true });
    return;
  }

  const lines = subagents.map((s) => {
    const status = s.isGenerating ? '🔄' : '💤';
    return `${status} \`${s.agentLabel}\` | <#${s.channelId}> | 深度：${s.subagentDepth}`;
  });

  await interaction.reply({ content: `活跃子任务：\n${lines.join('\n')}`, ephemeral: true });
}
