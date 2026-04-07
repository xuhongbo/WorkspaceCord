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
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

export async function handleSubagentRun(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.channel?.isThread()) {
    await interaction.reply({
      content: 'Run `/subagent run` in an agent session channel, not inside a thread.',
      ephemeral: true,
    });
    return;
  }

  const session = getSessionByChannel(interaction.channelId);
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
  const session = getSessionByChannel(interaction.channelId);
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
