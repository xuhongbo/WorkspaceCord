import { SlashCommandBuilder } from 'discord.js';

export function buildShellCommand() {
  return new SlashCommandBuilder()
    .setName('shell')
    .setDescription('在项目目录中执行命令')
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('执行一条命令')
        .addStringOption((opt) => opt.setName('command').setDescription('要执行的命令').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('processes').setDescription('列出正在运行的命令进程'))
    .addSubcommand((sub) =>
      sub
        .setName('kill')
        .setDescription('结束一个运行中的进程')
        .addIntegerOption((opt) => opt.setName('pid').setDescription('进程编号').setRequired(true)),
    );
}
