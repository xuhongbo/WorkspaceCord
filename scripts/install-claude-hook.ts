#!/usr/bin/env node
// Claude 钩子安装脚本
// 自动配置 ~/.claude/hooks/ 和 ~/.claude/config.json

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_HOOKS_DIR = path.join(homedir(), '.claude', 'hooks');
const CLAUDE_CONFIG_PATH = path.join(homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT_NAME = 'workspacecord-hook.cjs';
const SOURCE_HOOK_PATH = path.join(__dirname, '..', '.claude', 'hooks', HOOK_SCRIPT_NAME);

const REQUIRED_HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'AskUser',
  'Stop',
];

type ClaudeSettings = {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
};

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✓ 创建目录: ${dir}`);
  }
}

function installHookScript(): boolean {
  ensureDir(CLAUDE_HOOKS_DIR);

  const targetPath = path.join(CLAUDE_HOOKS_DIR, HOOK_SCRIPT_NAME);

  if (!fs.existsSync(SOURCE_HOOK_PATH)) {
    console.error(`✗ 源钩子脚本不存在: ${SOURCE_HOOK_PATH}`);
    return false;
  }

  try {
    fs.copyFileSync(SOURCE_HOOK_PATH, targetPath);
    fs.chmodSync(targetPath, 0o755);
    console.log(`✓ 安装钩子脚本: ${targetPath}`);
    return true;
  } catch (err) {
    console.error(`✗ 安装钩子脚本失败: ${(err as Error).message}`);
    return false;
  }
}

function updateClaudeConfig(): boolean {
  let config: ClaudeSettings = {};

  if (fs.existsSync(CLAUDE_CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf8');
      config = JSON.parse(content);
      console.log(`✓ 读取现有配置: ${CLAUDE_CONFIG_PATH}`);
    } catch (err) {
      console.error(`✗ 解析配置文件失败: ${(err as Error).message}`);
      return false;
    }
  } else {
    console.log(`! 配置文件不存在,将创建新配置: ${CLAUDE_CONFIG_PATH}`);
  }

  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }

  let updated = false;
  for (const hookName of REQUIRED_HOOKS) {
    const command = `node "${path.join(CLAUDE_HOOKS_DIR, HOOK_SCRIPT_NAME)}" ${hookName}`;
    if (!hasHookCommand(config.hooks[hookName], HOOK_SCRIPT_NAME)) {
      config.hooks[hookName] = [
        {
          hooks: [
            {
              type: 'command',
              command,
            },
          ],
        },
      ];
      console.log(`✓ 配置钩子: ${hookName}`);
      updated = true;
    }
  }

  if (!updated) {
    console.log(`✓ 钩子配置已是最新`);
    return true;
  }

  try {
    ensureDir(path.dirname(CLAUDE_CONFIG_PATH));
    fs.writeFileSync(CLAUDE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    console.log(`✓ 更新配置文件: ${CLAUDE_CONFIG_PATH}`);
    return true;
  } catch (err) {
    console.error(`✗ 写入配置文件失败: ${(err as Error).message}`);
    return false;
  }
}

function hasHookCommand(entry: unknown, scriptName: string): boolean {
  if (!entry) return false;

  if (Array.isArray(entry)) {
    return entry.some((item) => hasHookCommand(item, scriptName));
  }

  if (typeof entry === 'string') {
    return entry.includes(scriptName);
  }

  if (typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.command === 'string' && obj.command.includes(scriptName)) {
      return true;
    }
    return Object.values(obj).some((value) => hasHookCommand(value, scriptName));
  }

  return false;
}

function main(): void {
  console.log('=== workspacecord Claude 钩子安装 ===\n');

  const scriptOk = installHookScript();
  const configOk = updateClaudeConfig();

  console.log('\n=== 安装完成 ===');

  if (scriptOk && configOk) {
    console.log('✓ 所有步骤成功完成');
    console.log('\n下次启动 Claude Code 时,钩子将自动生效');
    process.exit(0);
  } else {
    console.log('✗ 部分步骤失败,请检查错误信息');
    process.exit(1);
  }
}

main();
