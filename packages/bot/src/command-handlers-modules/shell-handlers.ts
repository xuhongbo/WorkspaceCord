import type { ChatInputCommandInteraction } from 'discord.js';
import { config, formatUptime } from '@workspacecord/core';
import { getSessionByChannel } from '@workspacecord/engine/session-registry';
import * as projectMgr from '@workspacecord/engine/project-manager';
import { executeShellCommand, listProcesses, killProcess } from '../shell-handler.ts';
import {
  assertUserAllowed,
  resolveProjectCategoryId,
  type SessionChannel,
} from '../command-handlers-shared.ts';

export async function handleShell(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!config.shellEnabled) {
    await interaction.reply({
      content:
        'Shell 执行已禁用。请使用 `workspacecord config set SHELL_ENABLED true` 启用，并设置 SHELL_ALLOWED_USERS。',
      ephemeral: true,
    });
    return;
  }
  if (!assertUserAllowed(interaction)) return;
  const allowedByShellList =
    config.shellAllowedUsers.length === 0 || config.shellAllowedUsers.includes(interaction.user.id);
  if (!allowedByShellList) {
    await interaction.reply({
      content: '你没有 Shell 访问权限。',
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
      await interaction.reply({ content: `未知子命令：${sub}`, ephemeral: true });
  }
}

export async function handleShellRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = interaction.options.getString('command', true);
  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({ content: '无频道上下文。', ephemeral: true });
    return;
  }

  let cwd = process.cwd();
  const session = getSessionByChannel(channel.id);
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
  await interaction.editReply(`执行中：\`${command}\``);

  await executeShellCommand(command, cwd, channel as SessionChannel);
}

async function handleShellProcesses(interaction: ChatInputCommandInteraction): Promise<void> {
  const procs = listProcesses();
  if (procs.length === 0) {
    await interaction.reply({ content: '没有运行中的 Shell 进程。', ephemeral: true });
    return;
  }
  const lines = procs.map((p) => `**PID ${p.pid}** — \`${p.command}\` (${formatUptime(p.startedAt)})`);
  await interaction.reply({ content: `运行中的进程：\n${lines.join('\n')}`, ephemeral: true });
}

async function handleShellKill(interaction: ChatInputCommandInteraction): Promise<void> {
  const pid = interaction.options.getInteger('pid', true);
  const killed = killProcess(pid);
  await interaction.reply({
    content: killed ? `进程 ${pid} 已终止。` : `进程 ${pid} 未找到。`,
    ephemeral: true,
  });
}
