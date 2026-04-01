import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const commands = [
  // ── /project ──────────────────────────────────────────────────────
  new SlashCommandBuilder()
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
    .addSubcommand((sub) => sub.setName('mcp-list').setDescription('列出当前项目配置的 MCP 服务')),

  // ── /agent ────────────────────────────────────────────────────────
  new SlashCommandBuilder()
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
          opt.setName('directory').setDescription('覆盖默认工作目录').setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('列出当前项目下的全部活跃主会话'))
    .addSubcommand((sub) =>
      sub.setName('archive').setDescription('把当前会话归档到 #history 并删除频道'),
    )
    .addSubcommand((sub) =>
      sub.setName('cleanup').setDescription('预览并批量归档当前项目下的其他空闲会话'),
    )
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
        .addStringOption((opt) =>
          opt.setName('model').setDescription('模型名称').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('continue').setDescription('继续当前会话的生成')),

  // ── /subagent ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('subagent')
    .setDescription('管理子代理线程')
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('在当前主会话下创建一个子代理线程')
        .addStringOption((opt) =>
          opt.setName('label').setDescription('子代理名称').setRequired(true),
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
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('列出当前主会话下的子代理线程')),

  // ── /shell ────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('shell')
    .setDescription('在项目目录中执行命令')
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('执行一条命令')
        .addStringOption((opt) =>
          opt.setName('command').setDescription('要执行的命令').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('processes').setDescription('列出正在运行的命令进程'))
    .addSubcommand((sub) =>
      sub
        .setName('kill')
        .setDescription('结束一个运行中的进程')
        .addIntegerOption((opt) => opt.setName('pid').setDescription('进程编号').setRequired(true)),
    ),

  // ── 快捷命令（无 subcommand） ─────────────────────────────────────
  new SlashCommandBuilder()
    .setName('spawn')
    .setDescription('创建新的代理会话（快捷方式）')
    .addStringOption((opt) =>
      opt.setName('label').setDescription('会话名称，例如 fix-login-bug').setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('provider')
        .setDescription('选择代理提供方')
        .setRequired(false)
        .addChoices({ name: 'Codex（默认）', value: 'codex' }, { name: 'Claude', value: 'claude' }),
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
      opt.setName('directory').setDescription('覆盖默认工作目录').setRequired(false),
    ),

  new SlashCommandBuilder().setName('stop').setDescription('停止当前会话的生成'),

  new SlashCommandBuilder().setName('end').setDescription('结束当前会话'),

  new SlashCommandBuilder()
    .setName('run')
    .setDescription('在当前会话下创建子代理线程')
    .addStringOption((opt) => opt.setName('label').setDescription('子代理名称').setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName('provider')
        .setDescription('选择代理提供方')
        .setRequired(false)
        .addChoices({ name: 'Codex（默认）', value: 'codex' }, { name: 'Claude', value: 'claude' }),
    ),
];

export function getCommandDefinitions() {
  return commands.map((command) => command.toJSON());
}

const HASH_FILE = join(config.dataDir, 'commands-hash.txt');

function computeCommandsHash(body: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function readStoredHash(): string | null {
  try {
    if (existsSync(HASH_FILE)) {
      return readFileSync(HASH_FILE, 'utf-8').trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeStoredHash(hash: string): void {
  try {
    writeFileSync(HASH_FILE, hash, 'utf-8');
  } catch {
    /* ignore */
  }
}

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = getCommandDefinitions();

  const currentHash = computeCommandsHash(body);
  const storedHash = readStoredHash();

  if (currentHash === storedHash) {
    console.log(`[commands] ${body.length} commands unchanged, skipping registration`);
    return;
  }

  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    console.log(`[commands] Registered ${body.length} guild commands`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log(`[commands] Registered ${body.length} global commands`);
  }

  writeStoredHash(currentHash);
}
