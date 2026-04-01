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

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: optional('DISCORD_GUILD_ID', ''),

  allowedUsers: optionalList('ALLOWED_USERS'),
  allowAllUsers: optionalBool('ALLOW_ALL_USERS', false),

  dataDir: join(homedir(), '.workspacecord'),

  defaultProvider: optional('DEFAULT_PROVIDER', 'codex') as ProviderName,
  defaultMode: optional('DEFAULT_MODE', 'auto') as SessionMode,
  claudePermissionMode: optional('CLAUDE_PERMISSION_MODE', 'normal') as 'bypass' | 'normal',

  maxSubagentDepth: optionalInt('MAX_SUBAGENT_DEPTH', 3),
  maxActiveSessionsPerProject: optionalInt('MAX_ACTIVE_SESSIONS', 20),
  autoArchiveDays: optionalInt('AUTO_ARCHIVE_DAYS', 7),

  messageRetentionDays: optionalInt('MESSAGE_RETENTION_DAYS', 0),
  rateLimitMs: optionalInt('RATE_LIMIT_MS', 1000),

  shellEnabled: optionalBool('SHELL_ENABLED', false),
  shellAllowedUsers: optionalList('SHELL_ALLOWED_USERS'),

  codexSandboxMode: optional('CODEX_SANDBOX_MODE', 'workspace-write') as
    | 'read-only'
    | 'workspace-write'
    | 'danger-full-access',
  codexApprovalPolicy: optional('CODEX_APPROVAL_POLICY', 'on-failure') as
    | 'never'
    | 'on-request'
    | 'on-failure'
    | 'untrusted',
  codexNetworkAccessEnabled: optionalBool('CODEX_NETWORK_ACCESS_ENABLED', false),
  codexWebSearchMode: optional('CODEX_WEB_SEARCH', 'disabled') as 'disabled' | 'cached' | 'live',
  codexReasoningEffort: optional('CODEX_REASONING_EFFORT', '') as
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | '',
  codexBaseUrl: optional('CODEX_BASE_URL', ''),
  codexApiKey: optional('CODEX_API_KEY', ''),
  codexPath: optional('CODEX_PATH', ''),

  anthropicApiKey: optional('ANTHROPIC_API_KEY', ''),
  anthropicBaseUrl: optional('ANTHROPIC_BASE_URL', ''),

  sessionSyncIntervalMs: optionalInt('SESSION_SYNC_INTERVAL_MS', 30_000),

  healthReportIntervalMs: optionalInt('HEALTH_REPORT_INTERVAL_MS', 600_000),
  healthReportEnabled: optionalBool('HEALTH_REPORT_ENABLED', true),
  healthCheckStuckThresholdMs: optionalInt('HEALTH_CHECK_STUCK_THRESHOLD_MS', 1_800_000),
  healthCheckIdleThresholdMs: optionalInt('HEALTH_CHECK_IDLE_THRESHOLD_MS', 7_200_000),
} as const;

if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
if (config.anthropicBaseUrl) process.env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;

if (config.allowedUsers.length === 0 && !config.allowAllUsers) {
  if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
    console.error('ERROR: Set ALLOWED_USERS or ALLOW_ALL_USERS=true');
    process.exit(1);
  }
}
