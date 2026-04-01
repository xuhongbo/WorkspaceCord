// Claude 钩子健康检查
// 参考设计文档第 8.5 节

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Client, TextChannel } from 'discord.js';

const HOOK_SCRIPT_PATH = path.join(homedir(), '.claude', 'hooks', 'workspacecord-hook.cjs');
const HOOK_FAILURE_LOG_PATH = path.join(homedir(), '.workspacecord', 'hook-failures.log');
const CLAUDE_CONFIG_PATHS = [
  path.join(homedir(), '.claude', 'settings.json'),
  path.join(homedir(), '.claude', 'config.json'),
];

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

  // 检查钩子脚本是否存在
  if (!fs.existsSync(HOOK_SCRIPT_PATH)) {
    issues.push('钩子脚本不存在: ~/.claude/hooks/workspacecord-hook.cjs');
  } else {
    // 检查脚本是否可执行
    try {
      const stats = fs.statSync(HOOK_SCRIPT_PATH);
      if (!(stats.mode & 0o111)) {
        warnings.push('钩子脚本不可执行,请运行: chmod +x ~/.claude/hooks/workspacecord-hook.cjs');
      }
    } catch (err) {
      warnings.push(`无法检查钩子脚本权限: ${(err as Error).message}`);
    }
  }

  // 检查 Claude 配置文件
  const configPath = CLAUDE_CONFIG_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    warnings.push('Claude 配置文件不存在: ~/.claude/settings.json 或 ~/.claude/config.json');
  } else {
    try {
      const configContent = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(configContent);

      // 检查钩子是否已配置
      if (!config.hooks || typeof config.hooks !== 'object') {
        issues.push('Claude 配置中未找到 hooks 配置');
      } else {
        const requiredHooks = [
          'SessionStart',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'Stop',
          'AskUser',
        ];
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
    // 健康状态,不发送通知
    return;
  }

  const embed = {
    title: status.isHealthy ? '⚠️ Claude 钩子配置警告' : '❌ Claude 钩子配置异常',
    color: status.isHealthy ? 0xf39c12 : 0xe74c3c,
    fields: [] as Array<{ name: string; value: string }>,
    timestamp: new Date().toISOString(),
  };

  if (status.issues.length > 0) {
    embed.fields.push({
      name: '问题',
      value: status.issues.map((issue) => `• ${issue}`).join('\n'),
    });
  }

  if (status.warnings.length > 0) {
    embed.fields.push({
      name: '警告',
      value: status.warnings.map((warning) => `• ${warning}`).join('\n'),
    });
  }

  embed.fields.push({
    name: '影响',
    value: status.isHealthy
      ? '钩子可能无法正常工作,本地 Claude 会话可能无法实时同步到 Discord'
      : '本地 Claude 会话将无法实时同步到 Discord,仅能通过补漏层发现(延迟约 30 秒)',
  });

  try {
    await channel.send({ embeds: [embed] });
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
