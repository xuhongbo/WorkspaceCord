import Configstore from 'configstore';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SENSITIVE_KEYS = new Set(['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY']);

export const VALID_KEYS = new Set([
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'ALLOWED_USERS',
  'ALLOW_ALL_USERS',
  'DEFAULT_PROVIDER',
  'DEFAULT_MODE',
  'CLAUDE_PERMISSION_MODE',
  'MAX_SUBAGENT_DEPTH',
  'MAX_ACTIVE_SESSIONS',
  'AUTO_ARCHIVE_DAYS',
  'CODEX_SANDBOX_MODE',
  'CODEX_APPROVAL_POLICY',
  'CODEX_NETWORK_ACCESS_ENABLED',
  'CODEX_WEB_SEARCH',
  'CODEX_REASONING_EFFORT',
  'CODEX_PATH',
  'CODEX_API_KEY',
  'CODEX_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'MESSAGE_RETENTION_DAYS',
  'RATE_LIMIT_MS',
  'ACK_REACTION',
  'REPLY_TO_MODE',
  'TEXT_CHUNK_LIMIT',
  'CHUNK_MODE',
  'SHELL_ENABLED',
  'SHELL_ALLOWED_USERS',
  'SESSION_SYNC_INTERVAL_MS',
  'SESSION_SYNC_RECENT_DAYS',
  'HEALTH_REPORT_ENABLED',
  'HEALTH_REPORT_INTERVAL_MS',
  'HEALTH_CHECK_STUCK_THRESHOLD_MS',
  'HEALTH_CHECK_IDLE_THRESHOLD_MS',
  'HOOK_SECRET',
]);

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_APPROVAL_POLICIES = new Set(['never', 'on-request', 'on-failure', 'untrusted']);

let store: Configstore | null = null;

const DEFAULT_TEST_CONFIG_PATH = join(process.cwd(), '.workspacecord-config.json');
const DEFAULT_TEST_FALLBACK_PATH = join(process.cwd(), '.workspacecord-config-fallback.json');

function isTestEnvironment(): boolean {
  return process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
}

function resolveGlobalConfigPath(): string {
  if (process.env.WORKSPACECORD_CONFIG_PATH) {
    return process.env.WORKSPACECORD_CONFIG_PATH;
  }
  if (isTestEnvironment()) {
    return DEFAULT_TEST_CONFIG_PATH;
  }
  const baseDir = process.env.WORKSPACECORD_CONFIG_DIR
    ? process.env.WORKSPACECORD_CONFIG_DIR
    : join(homedir(), '.config', 'workspacecord');
  return join(baseDir, 'config.json');
}

function createConfigStore(path: string): Configstore {
  try {
    return new Configstore('workspacecord', {}, { configPath: path });
  } catch (err) {
    if (!isTestEnvironment() || path === DEFAULT_TEST_CONFIG_PATH || path === DEFAULT_TEST_FALLBACK_PATH) {
      throw err;
    }
    return new Configstore('workspacecord', {}, { configPath: DEFAULT_TEST_FALLBACK_PATH });
  }
}

function getStore(): Configstore {
  if (!store) {
    const path = resolveGlobalConfigPath();
    store = createConfigStore(path);
  }
  return store;
}

/** 仅测试时使用，替换底层 store 实例 */
export function _setStoreForTest(s: Configstore): void {
  store = s;
}

/**
 * 校验配置值。返回 null 表示合法，返回字符串表示错误信息。
 */
export function validateConfigValue(key: string, value: string): string | null {
  if (!VALID_KEYS.has(key)) {
    return `Unknown config key: ${key}. Valid keys: ${Array.from(VALID_KEYS).join(', ')}`;
  }
  switch (key) {
    case 'CODEX_SANDBOX_MODE':
      if (!CODEX_SANDBOX_MODES.has(value)) {
        return `Invalid value for CODEX_SANDBOX_MODE. Expected one of: ${Array.from(CODEX_SANDBOX_MODES).join(', ')}`;
      }
      break;
    case 'CODEX_APPROVAL_POLICY':
      if (!CODEX_APPROVAL_POLICIES.has(value)) {
        return `Invalid value for CODEX_APPROVAL_POLICY. Expected one of: ${Array.from(CODEX_APPROVAL_POLICIES).join(', ')}`;
      }
      break;
    case 'ALLOW_ALL_USERS':
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for ALLOW_ALL_USERS. Expected "true" or "false"`;
      }
      break;

    case 'SHELL_ENABLED':
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for SHELL_ENABLED. Expected "true" or "false"`;
      }
      break;
    case 'TEXT_CHUNK_LIMIT': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 2000) {
        return `Invalid value for ${key}. Expected an integer between 1 and 2000`;
      }
      break;
    }
    case 'ACK_REACTION':
      if (value === '') break;
      if (/^<a?:[A-Za-z0-9_~]+:\d+>$/.test(value)) break;
      if (/\s/.test(value)) {
        return 'Invalid value for ACK_REACTION. Expected a Unicode emoji, empty string, or custom emoji like <:name:id>';
      }
      break;
    case 'REPLY_TO_MODE':
      if (!['off', 'first', 'all'].includes(value)) {
        return `Invalid value for REPLY_TO_MODE. Expected one of: off, first, all`;
      }
      break;
    case 'CHUNK_MODE':
      if (!['length', 'newline'].includes(value)) {
        return `Invalid value for CHUNK_MODE. Expected one of: length, newline`;
      }
      break;
    case 'RATE_LIMIT_MS':
    case 'SESSION_SYNC_INTERVAL_MS':
    case 'SESSION_SYNC_RECENT_DAYS':
    case 'HEALTH_REPORT_INTERVAL_MS':
    case 'HEALTH_CHECK_STUCK_THRESHOLD_MS':
    case 'HEALTH_CHECK_IDLE_THRESHOLD_MS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return `Invalid value for ${key}. Expected a non-negative integer`;
      }
      break;
    }
    case 'HEALTH_REPORT_ENABLED':
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for HEALTH_REPORT_ENABLED. Expected "true" or "false"`;
      }
      break;
    case 'MAX_SUBAGENT_DEPTH':
    case 'MAX_ACTIVE_SESSIONS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `Invalid value for ${key}. Expected a positive integer`;
      }
      break;
    }
    case 'MESSAGE_RETENTION_DAYS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `Invalid value for MESSAGE_RETENTION_DAYS. Expected a positive integer`;
      }
      break;
    }
    case 'AUTO_ARCHIVE_DAYS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return `Invalid value for AUTO_ARCHIVE_DAYS. Expected a non-negative integer`;
      }
      break;
    }
    case 'DEFAULT_PROVIDER':
      if (!['claude', 'codex'].includes(value)) {
        return `Invalid value for DEFAULT_PROVIDER. Expected one of: claude, codex`;
      }
      break;
    case 'DEFAULT_MODE':
      if (!['auto', 'plan', 'normal', 'monitor'].includes(value)) {
        return `Invalid value for DEFAULT_MODE. Expected one of: auto, plan, normal, monitor`;
      }
      break;
    case 'CLAUDE_PERMISSION_MODE':
      if (!['bypass', 'normal'].includes(value)) {
        return `Invalid value for CLAUDE_PERMISSION_MODE. Expected one of: bypass, normal`;
      }
      break;
    case 'CODEX_WEB_SEARCH':
      if (!['disabled', 'cached', 'live'].includes(value)) {
        return `Invalid value for CODEX_WEB_SEARCH. Expected one of: disabled, cached, live`;
      }
      break;
    case 'CODEX_REASONING_EFFORT':
      if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
        return `Invalid value for CODEX_REASONING_EFFORT. Expected one of: minimal, low, medium, high, xhigh`;
      }
      break;
  }
  return null;
}

/**
 * 对敏感值打码：保留首尾各 4 字符，中间替换为 ********
 */
export function maskSensitive(key: string, value: string): string {
  if (!SENSITIVE_KEYS.has(key)) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

/**
 * 从 Anthropic 官方配置文件读取
 * ~/.claude/settings.json
 */
function readAnthropicConfig(key: string): string | undefined {
  const path = join(homedir(), '.claude', 'settings.json');

  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const config = JSON.parse(content);
      const env = config.env || {};

      if (key === 'ANTHROPIC_API_KEY') {
        return env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
      }
      if (key === 'ANTHROPIC_BASE_URL') {
        return env.ANTHROPIC_BASE_URL;
      }
    }
  } catch {
    // ignore parse errors
  }
  return undefined;
}

/**
 * 从 Codex 官方配置文件读取
 * ~/.codex/config.json
 */
function readCodexConfig(key: string): string | undefined {
  const path = join(homedir(), '.codex', 'config.json');
  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const config = JSON.parse(content);
      if (key === 'CODEX_API_KEY' && config.api_key) {
        return config.api_key;
      }
      if (key === 'CODEX_BASE_URL' && config.base_url) {
        return config.base_url;
      }
    }
  } catch {
    // ignore parse errors
  }
  return undefined;
}

export function getConfigValue(key: string): string | undefined {
  // 优先从 Configstore 读取
  const storeValue = getStore().get(key) as string | undefined;
  if (storeValue !== undefined) {
    return storeValue;
  }
  // 其次从环境变量读取
  const envValue = process.env[key];
  if (envValue !== undefined) {
    return envValue;
  }
  // 最后尝试从官方配置文件读取（仅 API keys）
  if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_BASE_URL') {
    return readAnthropicConfig(key);
  }
  if (key === 'CODEX_API_KEY' || key === 'CODEX_BASE_URL') {
    return readCodexConfig(key);
  }
  return undefined;
}

export function setConfigValue(key: string, value: string): void {
  getStore().set(key, value);
}

export function deleteConfigValue(key: string): void {
  getStore().delete(key);
}

export function getAllConfig(): Record<string, string> {
  return (getStore().all ?? {}) as Record<string, string>;
}

export function getConfigPath(): string {
  return getStore().path;
}
