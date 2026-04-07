import type { ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.ts';
import * as sessionMgr from '../thread-manager.ts';
import * as projectMgr from '../project-manager.ts';
import { executeShellCommand, listProcesses, killProcess } from '../shell-handler.ts';
import { formatUptime } from '../utils.ts';
import {
  assertUserAllowed,
  resolveProjectCategoryId,
  type SessionChannel,
} from '../command-handlers-shared.ts';

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

export async function handleShellRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = interaction.options.getString('command', true);
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: 'No channel context.', ephemeral: true });
    return;
  }

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
  const lines = procs.map((p) => `**PID ${p.pid}** — \`${p.command}\` (${formatUptime(p.startedAt)})`);
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
