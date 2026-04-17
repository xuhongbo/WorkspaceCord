import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderName, SessionMode } from './types.ts';
import { getConfigValue } from './global-config.ts';

function required(key: string): string {
  const value = getConfigValue(key);
  if (!value) {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
      return `test-${key.toLowerCase()}`;
    }
    console.error(`ERROR: ${key} is not configured.`);
    console.error('Run \x1b[36mworkspacecord config setup\x1b[0m to configure.');
    process.exit(1);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return getConfigValue(key) ?? fallback;
}

function optionalList(key: string, fallback: string[] = []): string[] {
  const value = getConfigValue(key);
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalInt(key: string, fallback: number): number {
  const value = getConfigValue(key);
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const value = getConfigValue(key);
  if (!value) return fallback;
  return value === 'true' || value === '1';
}

function optionalEnum<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const value = getConfigValue(key);
  if (!value) return fallback;
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: optional('DISCORD_GUILD_ID', ''),

  allowedUsers: optionalList('ALLOWED_USERS'),
  allowAllUsers: optionalBool('ALLOW_ALL_USERS', false),

  dataDir: join(homedir(), '.workspacecord'),

  defaultProvider: optionalEnum('DEFAULT_PROVIDER', 'codex', ['claude', 'codex']) as ProviderName,
  defaultMode: optionalEnum('DEFAULT_MODE', 'auto', ['auto', 'plan', 'normal', 'monitor']) as SessionMode,
  claudePermissionMode: optionalEnum('CLAUDE_PERMISSION_MODE', 'normal', ['bypass', 'normal']),

  maxSubagentDepth: optionalInt('MAX_SUBAGENT_DEPTH', 3),
  maxActiveSessionsPerProject: optionalInt('MAX_ACTIVE_SESSIONS', 20),
  autoArchiveDays: optionalInt('AUTO_ARCHIVE_DAYS', 7),

  messageRetentionDays: optionalInt('MESSAGE_RETENTION_DAYS', 0),
  rateLimitMs: optionalInt('RATE_LIMIT_MS', 1000),
  ackReaction: optional('ACK_REACTION', '👀'),
  replyToMode: optionalEnum('REPLY_TO_MODE', 'first', ['off', 'first', 'all']),
  textChunkLimit: Math.max(1, Math.min(optionalInt('TEXT_CHUNK_LIMIT', 2000), 2000)),
  chunkMode: optionalEnum('CHUNK_MODE', 'length', ['length', 'newline']),
  socketPath: optional('IPC_SOCKET_PATH', '/tmp/workspacecord.sock'),

  shellEnabled: optionalBool('SHELL_ENABLED', false),
  shellAllowedUsers: optionalList('SHELL_ALLOWED_USERS'),

  codexSandboxMode: optionalEnum('CODEX_SANDBOX_MODE', 'workspace-write', ['read-only', 'workspace-write', 'danger-full-access']),
  codexApprovalPolicy: optionalEnum('CODEX_APPROVAL_POLICY', 'on-failure', ['never', 'on-request', 'on-failure', 'untrusted']),
  codexNetworkAccessEnabled: optionalBool('CODEX_NETWORK_ACCESS_ENABLED', true),
  codexWebSearchMode: optionalEnum('CODEX_WEB_SEARCH', 'live', ['disabled', 'cached', 'live']),
  codexReasoningEffort: optionalEnum('CODEX_REASONING_EFFORT', '', ['', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  /**
   * Reasoning effort applied to Monitor-mode evaluation passes (across both providers).
   * - Codex: forwarded to `modelReasoningEffort` on the monitor thread.
   * - Claude: if set to 'high' or 'xhigh', switches the monitor to `monitorClaudeModel` (default: claude-opus-4-7).
   * Empty string = inherit from the worker settings.
   */
  monitorReasoningEffort: optionalEnum('MONITOR_REASONING_EFFORT', 'high', ['', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  /** Claude model used for monitor passes when `monitorReasoningEffort` is high/xhigh. */
  monitorClaudeModel: optional('MONITOR_CLAUDE_MODEL', 'claude-opus-4-7'),
  codexBaseUrl: optional('CODEX_BASE_URL', ''),
  codexApiKey: optional('CODEX_API_KEY', ''),
  codexPath: optional('CODEX_PATH', ''),

  anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
  anthropicBaseUrl: optional('ANTHROPIC_BASE_URL', ''),

  sessionSyncIntervalMs: optionalInt('SESSION_SYNC_INTERVAL_MS', 30_000),
  sessionSyncRecentDays: optionalInt('SESSION_SYNC_RECENT_DAYS', 3),

  healthReportIntervalMs: optionalInt('HEALTH_REPORT_INTERVAL_MS', 600_000),
  healthReportEnabled: optionalBool('HEALTH_REPORT_ENABLED', true),
  healthCheckStuckThresholdMs: optionalInt('HEALTH_CHECK_STUCK_THRESHOLD_MS', 1_800_000),
  healthCheckIdleThresholdMs: optionalInt('HEALTH_CHECK_IDLE_THRESHOLD_MS', 7_200_000),

  hookSecret: optional('HOOK_SECRET', ''),

  /**
   * 重启后 Monitor run 自动续跑策略:
   *  - `abandon-only`(默认):只把 running 的 run 标记为 abandoned,不自动续跑
   *  - `resume-with-goal`:session 仍在 monitor 模式且保存了 goal → 重新拉起 monitor 循环
   */
  monitorAutoResumePolicy: optionalEnum(
    'MONITOR_AUTO_RESUME_POLICY',
    'abandon-only',
    ['abandon-only', 'resume-with-goal'],
  ),

  /**
   * 重启后 pending 人工门控的处理策略:
   *  - `invalidate-all`(默认):全部标记为 invalidated,Discord 消息置灰
   *  - `resume-pending`:保留 pending,按剩余时间重建 5 分钟超时,用户可继续审批
   */
  gateRestartPolicy: optionalEnum('GATE_RESTART_POLICY', 'invalidate-all', [
    'invalidate-all',
    'resume-pending',
  ]),
} as const;

if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
if (config.anthropicBaseUrl) process.env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;

if (config.allowedUsers.length === 0 && !config.allowAllUsers) {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    console.error('ERROR: no users are allowed because neither ALLOWED_USERS nor ALLOW_ALL_USERS is configured');
    process.exit(1);
  }
}
