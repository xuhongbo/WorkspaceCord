// 受管 Codex 启动器
// 设计文档 9.4 节：实现受管 Codex 会话，支持远程审批能力

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getConfigValue } from '@workspacecord/core';

interface LaunchOptions {
  cwd?: string;
  model?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  args?: string[];
}

/**
 * 启动受管 Codex 会话
 *
 * 受管会话特点：
 * - 通过 workspacecord 代理启动
 * - 审批等待点可被守护进程感知
 * - Discord 上的允许/拒绝可写回会话
 * - 终端仍可直接处理
 */
export async function launchManagedCodex(options: LaunchOptions = {}): Promise<void> {
  const cwd = options.cwd || process.cwd();
  const codexBin = resolveCodexPath();

  // 验证工作目录
  if (!existsSync(cwd)) {
    console.error(`❌ 工作目录不存在: ${cwd}`);
    process.exit(1);
  }

  // 构建 Codex 命令参数
  const codexArgs: string[] = [];

  if (options.model) {
    codexArgs.push('--model', options.model);
  }

  if (options.sandboxMode) {
    codexArgs.push('--sandbox-mode', options.sandboxMode);
  }

  if (options.approvalPolicy) {
    codexArgs.push('--approval-policy', options.approvalPolicy);
  }

  // 添加受管标记（环境变量）
  const env = {
    ...process.env,
    workspacecord_MANAGED: '1',
    workspacecord_SESSION_CWD: cwd,
  };

  // 附加用户自定义参数
  if (options.args) {
    codexArgs.push(...options.args);
  }

  console.log('🚀 启动受管 Codex 会话...');
  console.log(`📁 工作目录: ${cwd}`);
  console.log(`🔧 参数: ${codexArgs.join(' ')}`);
  console.log('');
  console.log('💡 此会话支持 Discord 远程审批能力');
  console.log('   在 Discord 中可以远程允许/拒绝操作');
  console.log('');

  // 启动 Codex
  const codex = spawn(codexBin, codexArgs, {
    cwd,
    env,
    stdio: 'inherit',
  });

  codex.on('error', (err) => {
    console.error('❌ 启动 Codex 失败:', err.message);
    console.error('');
    console.error('请确保已安装 Codex CLI:');
    console.error('  npm install -g @openai/codex');
    process.exit(1);
  });

  codex.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n❌ Codex 退出，代码: ${code}`);
      process.exit(code);
    }
  });
}

function resolveCodexPath(): string {
  return process.env.CODEX_PATH || getConfigValue('CODEX_PATH') || 'codex';
}

/**
 * 检查会话是否为受管会话
 */
export function isManagedSession(): boolean {
  return process.env.workspacecord_MANAGED === '1';
}

/**
 * 获取受管会话的工作目录
 */
export function getManagedSessionCwd(): string | undefined {
  return process.env.workspacecord_SESSION_CWD;
}

/**
 * CLI 入口：解析命令行参数并启动受管 Codex
 */
export async function handleCodexCommand(args: string[]): Promise<void> {
  const options: LaunchOptions = {};

  // 解析参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--cwd':
        options.cwd = args[++i];
        break;
      case '--model':
        options.model = args[++i];
        break;
      case '--sandbox-mode':
        options.sandboxMode = args[++i] as LaunchOptions['sandboxMode'];
        break;
      case '--approval-policy':
        options.approvalPolicy = args[++i] as LaunchOptions['approvalPolicy'];
        break;
      case '--help':
      case '-h':
        printHelp();
        return;
      default:
        // 其他参数传递给 Codex
        if (!options.args) options.args = [];
        options.args.push(arg);
    }
  }

  await launchManagedCodex(options);
}

function printHelp(): void {
  console.log(`
\x1b[1mworkspacecord codex\x1b[0m — 启动受管 Codex 会话

\x1b[1m用法:\x1b[0m
  workspacecord codex [选项]

\x1b[1m选项:\x1b[0m
  --cwd <path>              工作目录（默认：当前目录）
  --model <model>           模型名称（如：gpt-4）
  --sandbox-mode <mode>     沙箱模式：read-only | workspace-write | danger-full-access
  --approval-policy <policy> 审批策略：never | on-request | on-failure | untrusted
  --help, -h                显示此帮助信息

\x1b[1m受管会话特性:\x1b[0m
  ✓ 快速发现 - 会话自动同步到 Discord
  ✓ 状态监控 - 实时显示执行状态
  ✓ 远程审批 - 在 Discord 中允许/拒绝操作
  ✓ 终端处理 - 仍可在终端直接处理

\x1b[1m示例:\x1b[0m
  workspacecord codex
  workspacecord codex --cwd /path/to/project
  workspacecord codex --model gpt-4 --sandbox-mode workspace-write

\x1b[2m更多信息: https://github.com/xuhongbo/workspacecord\x1b[0m
`);
}
