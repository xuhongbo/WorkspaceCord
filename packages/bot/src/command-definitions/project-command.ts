import { SlashCommandBuilder } from 'discord.js';

export function buildProjectCommand() {
  return new SlashCommandBuilder()
    .setName('project')
    .setDescription('管理项目与分类绑定')
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('把当前分类绑定到已挂载的本地项目，并创建历史归档区')
        .addStringOption((opt) =>
          opt
            .setName('project')
            .setDescription('已通过 workspacecord project init 挂载的项目名')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('info').setDescription('查看当前分类对应的项目信息'))
    .addSubcommand((sub) =>
      sub
        .setName('personality')
        .setDescription('设置该项目下所有代理共享的人格提示词')
        .addStringOption((opt) =>
          opt.setName('prompt').setDescription('应用到所有代理的系统提示词').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('personality-clear').setDescription('清除项目共享人格'))
    .addSubcommand((sub) =>
      sub
        .setName('skill-add')
        .setDescription('添加可复用技能提示词')
        .addStringOption((opt) => opt.setName('name').setDescription('技能名称').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('prompt').setDescription('技能提示词，可使用 {input} 占位').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('skill-remove')
        .setDescription('移除一个技能')
        .addStringOption((opt) => opt.setName('name').setDescription('技能名称').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('skill-list').setDescription('列出当前项目的全部技能'))
    .addSubcommand((sub) =>
      sub
        .setName('skill-run')
        .setDescription('执行一个技能提示词')
        .addStringOption((opt) => opt.setName('name').setDescription('技能名称').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('input').setDescription('替换到 {input} 的输入内容').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('mcp-add')
        .setDescription('为当前项目注册一个 MCP 服务')
        .addStringOption((opt) => opt.setName('name').setDescription('服务名称').setRequired(true))
        .addStringOption((opt) =>
          opt.setName('command').setDescription('启动 MCP 服务的命令').setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName('args').setDescription('逗号分隔的参数列表').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('mcp-remove')
        .setDescription('移除当前项目的 MCP 服务')
        .addStringOption((opt) => opt.setName('name').setDescription('服务名称').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('mcp-list').setDescription('列出当前项目配置的 MCP 服务'));
}
