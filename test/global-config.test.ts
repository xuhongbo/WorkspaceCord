import { beforeEach, describe, expect, it, vi } from 'vitest';
import Configstore from 'configstore';

// Mock configstore with an in-memory Map
vi.mock('configstore', () => {
  class MockConfigstore {
    private data: Map<string, string> = new Map();
    path = '/mock/configstore/workspacecord.json';

    get all(): Record<string, string> {
      return Object.fromEntries(this.data);
    }

    get(key: string): string | undefined {
      return this.data.get(key);
    }

    set(key: string, value: string): void {
      this.data.set(key, value);
    }

    delete(key: string): void {
      this.data.delete(key);
    }
  }
  return { default: MockConfigstore };
});

// Import after mock is set up
const {
  SENSITIVE_KEYS,
  VALID_KEYS,
  validateConfigValue,
  maskSensitive,
  getConfigValue,
  setConfigValue,
  deleteConfigValue,
  getAllConfig,
  getConfigPath,
  _setStoreForTest,
} = await import('../src/global-config.ts');

beforeEach(async () => {
  // Replace store instance with a fresh one before each test
  const fresh = new Configstore('workspacecord', {}, { globalConfigPath: true });
  _setStoreForTest(fresh);
});

describe('VALID_KEYS and SENSITIVE_KEYS', () => {
  it('includes expected valid keys', () => {
    expect(VALID_KEYS.has('DISCORD_TOKEN')).toBe(true);
    expect(VALID_KEYS.has('DISCORD_CLIENT_ID')).toBe(true);
    expect(VALID_KEYS.has('ALLOW_ALL_USERS')).toBe(true);
    expect(VALID_KEYS.has('RATE_LIMIT_MS')).toBe(true);
  });

  it('marks DISCORD_TOKEN as sensitive', () => {
    expect(SENSITIVE_KEYS.has('DISCORD_TOKEN')).toBe(true);
    expect(SENSITIVE_KEYS.has('DISCORD_CLIENT_ID')).toBe(false);
  });

  it('marks provider API keys as sensitive', () => {
    expect(SENSITIVE_KEYS.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(SENSITIVE_KEYS.has('CODEX_API_KEY')).toBe(true);
  });
});

describe('validateConfigValue', () => {
  it('returns null for valid DISCORD_TOKEN', () => {
    expect(validateConfigValue('DISCORD_TOKEN', 'some-token')).toBeNull();
  });

  it('rejects unknown keys', () => {
    const err = validateConfigValue('UNKNOWN_KEY', 'x');
    expect(err).not.toBeNull();
    expect(err).toContain('Unknown config key');
  });

  it('validates CODEX_SANDBOX_MODE', () => {
    expect(validateConfigValue('CODEX_SANDBOX_MODE', 'workspace-write')).toBeNull();
    expect(validateConfigValue('CODEX_SANDBOX_MODE', 'read-only')).toBeNull();
    expect(validateConfigValue('CODEX_SANDBOX_MODE', 'danger-full-access')).toBeNull();
    expect(validateConfigValue('CODEX_SANDBOX_MODE', 'invalid')).not.toBeNull();
  });

  it('validates CODEX_APPROVAL_POLICY', () => {
    expect(validateConfigValue('CODEX_APPROVAL_POLICY', 'never')).toBeNull();
    expect(validateConfigValue('CODEX_APPROVAL_POLICY', 'on-request')).toBeNull();
    expect(validateConfigValue('CODEX_APPROVAL_POLICY', 'on-failure')).toBeNull();
    expect(validateConfigValue('CODEX_APPROVAL_POLICY', 'untrusted')).toBeNull();
    expect(validateConfigValue('CODEX_APPROVAL_POLICY', 'always')).not.toBeNull();
  });

  it('validates ALLOW_ALL_USERS', () => {
    expect(validateConfigValue('ALLOW_ALL_USERS', 'true')).toBeNull();
    expect(validateConfigValue('ALLOW_ALL_USERS', 'false')).toBeNull();
    expect(validateConfigValue('ALLOW_ALL_USERS', 'yes')).not.toBeNull();
  });

  it('validates RATE_LIMIT_MS', () => {
    expect(validateConfigValue('RATE_LIMIT_MS', '1000')).toBeNull();
    expect(validateConfigValue('RATE_LIMIT_MS', '0')).toBeNull();
    expect(validateConfigValue('RATE_LIMIT_MS', '-1')).not.toBeNull();
    expect(validateConfigValue('RATE_LIMIT_MS', 'abc')).not.toBeNull();
    expect(validateConfigValue('RATE_LIMIT_MS', '1.5')).not.toBeNull();
  });

  it('validates MESSAGE_RETENTION_DAYS', () => {
    expect(validateConfigValue('MESSAGE_RETENTION_DAYS', '7')).toBeNull();
    expect(validateConfigValue('MESSAGE_RETENTION_DAYS', '0')).not.toBeNull();
    expect(validateConfigValue('MESSAGE_RETENTION_DAYS', '-1')).not.toBeNull();
  });

  it('validates workspacecord-specific config keys', () => {
    expect(validateConfigValue('DEFAULT_PROVIDER', 'claude')).toBeNull();
    expect(validateConfigValue('DEFAULT_MODE', 'monitor')).toBeNull();
    expect(validateConfigValue('MAX_SUBAGENT_DEPTH', '3')).toBeNull();
    expect(validateConfigValue('AUTO_ARCHIVE_DAYS', '0')).toBeNull();
    expect(validateConfigValue('CODEX_WEB_SEARCH', 'live')).toBeNull();
    expect(validateConfigValue('CODEX_REASONING_EFFORT', 'high')).toBeNull();
    expect(validateConfigValue('DEFAULT_PROVIDER', 'gemini')).not.toBeNull();
  });
});

describe('maskSensitive', () => {
  it('masks DISCORD_TOKEN', () => {
    const masked = maskSensitive('DISCORD_TOKEN', 'abcd1234XXXX5678efgh');
    expect(masked).toBe('abcd********efgh');
    expect(masked).not.toContain('1234XXXX5678');
  });

  it('returns full value for non-sensitive keys', () => {
    expect(maskSensitive('DISCORD_CLIENT_ID', '123456789')).toBe('123456789');
  });

  it('returns ******** for short sensitive values', () => {
    expect(maskSensitive('DISCORD_TOKEN', 'short')).toBe('********');
  });
});

describe('read/write/delete', () => {
  it('sets and gets a value', () => {
    setConfigValue('DISCORD_CLIENT_ID', '123456789012345678');
    expect(getConfigValue('DISCORD_CLIENT_ID')).toBe('123456789012345678');
  });

  it('returns undefined for missing key', () => {
    expect(getConfigValue('DISCORD_GUILD_ID')).toBeUndefined();
  });

  it('deletes a value', () => {
    setConfigValue('DISCORD_GUILD_ID', 'abc');
    deleteConfigValue('DISCORD_GUILD_ID');
    expect(getConfigValue('DISCORD_GUILD_ID')).toBeUndefined();
  });

  it('getAllConfig returns all stored values', () => {
    setConfigValue('DISCORD_CLIENT_ID', 'cid');
    setConfigValue('RATE_LIMIT_MS', '500');
    const all = getAllConfig();
    expect(all['DISCORD_CLIENT_ID']).toBe('cid');
    expect(all['RATE_LIMIT_MS']).toBe('500');
  });
});

describe('getConfigPath', () => {
  it('returns a path string', () => {
    const path = getConfigPath();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });
});
