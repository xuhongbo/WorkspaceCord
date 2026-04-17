import { SlashCommandBuilder } from 'discord.js';

export function buildAgentCommand() {
  return new SlashCommandBuilder()
    .setName('agent')
    .setDescription('管理主代理会话')
    .addSubcommand((sub) =>
      sub
        .setName('spawn')
        .setDescription('在当前项目分类下创建一个新的代理会话频道')
        .addStringOption((opt) =>
          opt.setName('label').setDescription('会话名称，例如 fix-login-bug').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('provider')
            .setDescription('选择代理提供方')
            .setRequired(false)
            .addChoices(
              { name: 'Codex（默认）', value: 'codex' },
              { name: 'Claude', value: 'claude' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('mode')
            .setDescription('执行模式')
            .setRequired(false)
            .addChoices(
              { name: '⚡ 自动：全自主执行', value: 'auto' },
              { name: '📋 计划：先规划再修改', value: 'plan' },
              { name: '🛡️ 普通：危险操作前询问', value: 'normal' },
              { name: '🧠 监督：持续推进直到完成', value: 'monitor' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('claude-permissions')
            .setDescription('Claude 权限模式（仅 Claude provider）')
            .setRequired(false)
            .addChoices(
              { name: '🛡️ 普通：需要用户确认操作', value: 'normal' },
              { name: '⚡ 绕过：完全自主（高风险）', value: 'bypass' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('codex-sandbox')
            .setDescription('Codex 沙箱模式（仅 Codex provider）')
            .setRequired(false)
            .addChoices(
              { name: '🔒 只读', value: 'read-only' },
              { name: '🛠️ 工作区可写', value: 'workspace-write' },
              { name: '⚠️ 完全访问', value: 'danger-full-access' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('codex-approval')
            .setDescription('Codex 审批策略（仅 Codex provider）')
            .setRequired(false)
            .addChoices(
              { name: '🚫 从不询问', value: 'never' },
              { name: '🙋 按需询问', value: 'on-request' },
              { name: '↩️ 失败后询问', value: 'on-failure' },
              { name: '🧾 非信任命令询问', value: 'untrusted' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('codex-bypass')
            .setDescription('Codex 一键全开（仅 Codex provider）')
            .setRequired(false)
            .addChoices(
              { name: '关闭', value: 'off' },
              { name: '开启', value: 'on' },
            ),
        )
        .addStringOption((opt) => opt.setName('directory').setDescription('覆盖默认工作目录').setRequired(false)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('列出当前项目下的全部活跃主会话'))
    .addSubcommand((sub) => sub.setName('archive').setDescription('把当前会话归档到 #history 并删除频道'))
    .addSubcommand((sub) => sub.setName('cleanup').setDescription('预览并批量归档当前项目下的其他空闲会话'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('停止当前会话中的生成'))
    .addSubcommand((sub) => sub.setName('end').setDescription('结束当前会话'))
    .addSubcommand((sub) =>
      sub
        .setName('mode')
        .setDescription('切换当前会话的执行模式')
        .addStringOption((opt) =>
          opt
            .setName('mode')
            .setDescription('新的执行模式')
            .setRequired(true)
            .addChoices(
              { name: '⚡ 自动', value: 'auto' },
              { name: '📋 计划', value: 'plan' },
              { name: '🛡️ 普通', value: 'normal' },
              { name: '🧠 监督', value: 'monitor' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('goal')
        .setDescription('设置当前会话的监督目标')
        .addStringOption((opt) => opt.setName('goal').setDescription('目标描述').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('persona')
        .setDescription('设置当前会话的代理人格')
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('人格名称')
            .setRequired(false)
            .addChoices(
              { name: '🔍 代码审查', value: 'code-reviewer' },
              { name: '🏗️ 架构设计', value: 'architect' },
              { name: '🐛 调试专家', value: 'debugger' },
              { name: '🔒 安全分析', value: 'security' },
              { name: '🚀 性能优化', value: 'performance' },
              { name: '⚙️ 运维工程', value: 'devops' },
              { name: '🧠 通用（默认）', value: 'general' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('verbose').setDescription('切换详细模式（显示工具调用）'))
    .addSubcommand((sub) =>
      sub
        .setName('model')
        .setDescription('设置当前会话的模型覆盖')
        .addStringOption((opt) => opt.setName('model').setDescription('模型名称').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('permissions')
        .setDescription('修改当前会话的权限设置')
        .addStringOption((opt) =>
          opt
            .setName('claude-permissions')
            .setDescription('Claude 权限模式（仅 Claude provider）')
            .setRequired(false)
            .addChoices(
              { name: '🛡️ 普通：需要用户确认操作', value: 'normal' },
              { name: '⚡ 绕过：完全自主（高风险）', value: 'bypass' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('codex-sandbox')
            .setDescription('Codex 沙箱模式（仅 Codex provider）')
            .setRequired(false)
            .addChoices(
              { name: '🔒 只读', value: 'read-only' },
              { name: '🛠️ 工作区可写', value: 'workspace-write' },
              { name: '⚠️ 完全访问', value: 'danger-full-access' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('codex-approval')
            .setDescription('Codex 审批策略（仅 Codex provider）')
            .setRequired(false)
            .addChoices(
              { name: '🚫 从不询问', value: 'never' },
              { name: '🙋 按需询问', value: 'on-request' },
              { name: '↩️ 失败后询问', value: 'on-failure' },
              { name: '🧾 非信任命令询问', value: 'untrusted' },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName('codex-bypass')
            .setDescription('Codex 一键全开（仅 Codex provider）')
            .setRequired(false)
            .addChoices(
              { name: '关闭', value: 'off' },
              { name: '开启', value: 'on' },
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('continue').setDescription('继续当前会话的生成'))
    .addSubcommand((sub) =>
      sub
        .setName('batch')
        .setDescription('批量审批模式（延后所有工具审批至一次性处理）')
        .addStringOption((opt) =>
          opt
            .setName('action')
            .setDescription('开关 / 一键批准 / 一键拒绝')
            .setRequired(true)
            .addChoices(
              { name: '开启批量审批模式', value: 'on' },
              { name: '关闭批量审批模式', value: 'off' },
              { name: '批准队列中的全部工具调用', value: 'approve-all' },
              { name: '拒绝队列中的全部工具调用', value: 'reject-all' },
            ),
        ),
    );
}
