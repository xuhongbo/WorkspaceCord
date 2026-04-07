import { SlashCommandBuilder } from 'discord.js';

export function buildSubagentCommand() {
  return new SlashCommandBuilder()
    .setName('subagent')
    .setDescription('管理子代理线程')
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('在当前主会话下创建一个子代理线程')
        .addStringOption((opt) => opt.setName('label').setDescription('子代理名称').setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName('provider')
            .setDescription('选择代理提供方')
            .setRequired(false)
            .addChoices(
              { name: 'Codex（默认）', value: 'codex' },
              { name: 'Claude', value: 'claude' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('列出当前主会话下的子代理线程'));
}
