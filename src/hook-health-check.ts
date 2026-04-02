// Claude 钩子健康检查
// 参考设计文档第 8.5 节

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Client, TextChannel } from 'discord.js';
import { config } from './config.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { deliver } from './discord/delivery.ts';

const HOOK_FAILURE_LOG_PATH = path.join(homedir(), '.workspacecord', 'hook-failures.log');
const PROJECT_REQUIRED_HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
];
const GLOBAL_REQUIRED_HOOKS = [...PROJECT_REQUIRED_HOOKS, 'AskUser'];

export interface HookHealthStatus {
  isHealthy: boolean;
  issues: string[];
  warnings: string[];
}

/**
 * 检查 Claude 钩子配置的健康状态
 */
export function checkHookHealth(): HookHealthStatus {
  const issues: string[] = [];
  const warnings: string[] = [];
  const developmentRuntime = process.env.NODE_ENV === 'development';
  const hookScriptCandidates = getHookScriptCandidates(developmentRuntime);
  const hookScriptPath = hookScriptCandidates.find((candidate) => fs.existsSync(candidate));

  // 检查钩子脚本是否存在
  if (!hookScriptPath) {
    issues.push(
      developmentRuntime
        ? '钩子脚本不存在: .claude/hooks/workspacecord-hook.cjs 或 ~/.claude/hooks/workspacecord-hook.cjs'
        : '钩子脚本不存在: ~/.claude/hooks/workspacecord-hook.cjs',
    );
  } else {
    // 检查脚本是否可执行
    try {
      const stats = fs.statSync(hookScriptPath);
      if (!(stats.mode & 0o111)) {
        warnings.push(
          developmentRuntime && hookScriptPath.startsWith(process.cwd())
            ? '钩子脚本不可执行,请运行: chmod +x .claude/hooks/workspacecord-hook.cjs'
            : '钩子脚本不可执行,请运行: chmod +x ~/.claude/hooks/workspacecord-hook.cjs',
        );
      }
    } catch (err) {
      warnings.push(`无法检查钩子脚本权限: ${(err as Error).message}`);
    }
  }

  // 检查 Claude 配置文件
  const configPath = getClaudeConfigPaths(developmentRuntime).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!configPath) {
    warnings.push(
      developmentRuntime
        ? 'Claude 配置文件不存在: .claude/settings.json、.claude/config.json、~/.claude/settings.json 或 ~/.claude/config.json'
        : 'Claude 配置文件不存在: ~/.claude/settings.json 或 ~/.claude/config.json',
    );
  } else {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent);

      // 检查钩子是否已配置
      if (!config.hooks || typeof config.hooks !== 'object') {
        issues.push('Claude 配置中未找到 hooks 配置');
      } else {
        const requiredHooks =
          developmentRuntime && configPath.startsWith(path.join(process.cwd(), '.claude'))
            ? PROJECT_REQUIRED_HOOKS
            : GLOBAL_REQUIRED_HOOKS;
        const missingHooks = requiredHooks.filter(
          (hook) => !hasHookCommand(config.hooks[hook], 'workspacecord-hook.cjs'),
        );

        if (missingHooks.length > 0) {
          issues.push(`以下钩子未配置: ${missingHooks.join(', ')}`);
        }
      }
    } catch (err) {
      issues.push(`无法解析 Claude 配置文件: ${(err as Error).message}`);
    }
  }

  // 检查最近是否有钩子失败日志
  if (fs.existsSync(HOOK_FAILURE_LOG_PATH)) {
    try {
      const stats = fs.statSync(HOOK_FAILURE_LOG_PATH);
      if (stats.size > 0) {
        warnings.push(
          '检测到钩子失败日志: ~/.workspacecord/hook-failures.log（建议排查守护进程连通性）',
        );
      }
    } catch (err) {
      warnings.push(`无法检查钩子失败日志: ${(err as Error).message}`);
    }
  }

  return {
    isHealthy: issues.length === 0,
    issues,
    warnings,
  };
}

function getHookScriptCandidates(developmentRuntime: boolean): string[] {
  const projectHookScriptPath = path.join(
    process.cwd(),
    '.claude',
    'hooks',
    'workspacecord-hook.cjs',
  );
  const globalHookScriptPath = path.join(homedir(), '.claude', 'hooks', 'workspacecord-hook.cjs');

  return developmentRuntime
    ? [projectHookScriptPath, globalHookScriptPath]
    : [globalHookScriptPath];
}

function getClaudeConfigPaths(developmentRuntime: boolean): string[] {
  const projectConfigPaths = [
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'config.json'),
  ];
  const globalConfigPaths = [
    path.join(homedir(), '.claude', 'settings.json'),
    path.join(homedir(), '.claude', 'config.json'),
  ];

  return developmentRuntime ? [...projectConfigPaths, ...globalConfigPaths] : globalConfigPaths;
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

/**
 * 在 Discord 中发送钩子健康检查通知
 */
export async function sendHookHealthNotification(
  client: Client,
  status: HookHealthStatus,
  notificationChannelId?: string,
): Promise<void> {
  if (!notificationChannelId) {
    console.warn('[Hook Health] No notification channel configured, skipping Discord notification');
    return;
  }

  const channel = client.channels.cache.get(notificationChannelId) as TextChannel | undefined;
  if (!channel || !('send' in channel)) {
    console.warn('[Hook Health] Notification channel not found or not a text channel');
    return;
  }

  if (status.isHealthy && status.warnings.length === 0) {
    return;
  }

  const lines = [
    status.isHealthy ? '⚠️ Claude 钩子配置警告' : '❌ Claude 钩子配置异常',
  ];

  if (status.issues.length > 0) {
    lines.push('', '问题：', ...status.issues.map((issue) => `- ${issue}`));
  }

  if (status.warnings.length > 0) {
    lines.push('', '警告：', ...status.warnings.map((warning) => `- ${warning}`));
  }

  lines.push(
    '',
    '影响：',
    status.isHealthy
      ? '钩子可能无法正常工作,本地 Claude 会话可能无法实时同步到 Discord'
      : '本地 Claude 会话将无法实时同步到 Discord,仅能通过补漏层发现(延迟约 30 秒)',
  );

  try {
    const plan = buildDeliveryPlan({
      sessionId: `hook-health:${notificationChannelId}`,
      chatId: notificationChannelId,
      text: lines.join('\n'),
      files: [],
      mode: 'system_notice',
      policy: {
        textChunkLimit: config.textChunkLimit ?? 2000,
        chunkMode: config.chunkMode ?? 'length',
        replyToMode: config.replyToMode ?? 'first',
        ackReaction: config.ackReaction ?? '👀',
      },
    });
    await deliver(channel, plan);
  } catch (err) {
    console.error('[Hook Health] Failed to send notification:', err);
  }
}

/**
 * 在控制台输出钩子健康检查结果
 */
export function logHookHealthStatus(status: HookHealthStatus): void {
  if (status.isHealthy && status.warnings.length === 0) {
    console.log('[Hook Health] ✓ Claude 钩子配置正常');
    return;
  }

  if (!status.isHealthy) {
    console.error('[Hook Health] ✗ Claude 钩子配置异常:');
    status.issues.forEach((issue) => console.error(`  • ${issue}`));
  }

  if (status.warnings.length > 0) {
    console.warn('[Hook Health] ⚠ 警告:');
    status.warnings.forEach((warning) => console.warn(`  • ${warning}`));
  }
}
