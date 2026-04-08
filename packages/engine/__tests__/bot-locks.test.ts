import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock, isLocked, getLockInfo } from '../src/bot-locks.ts';
import { config } from '@workspacecord/core';

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/core')>();
  return {
    ...actual,
    config: {
      dataDir: '',
    },
  };
});

describe('bot-locks', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = join(tmpdir(), `workspacecord-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('acquires lock when no lock file exists', async () => {
    vi.doMock('@workspacecord/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@workspacecord/core')>();
      return { ...actual, config: { dataDir: tempDir } };
    });
    const { acquireLock, releaseLock, isLocked } = await import('../src/bot-locks.ts');

    expect(acquireLock()).toBe(true);
    expect(isLocked()).toBe(true);

    releaseLock();
    expect(isLocked()).toBe(false);
  });

  it('blocks acquire when lock is held by running process', async () => {
    vi.doMock('@workspacecord/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@workspacecord/core')>();
      return { ...actual, config: { dataDir: tempDir } };
    });
    const { acquireLock, releaseLock } = await import('../src/bot-locks.ts');

    acquireLock();
    // Same process, so PID check will say process is running
    expect(acquireLock()).toBe(false);

    releaseLock();
  });

  it('releases lock only for same PID', async () => {
    vi.doMock('@workspacecord/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@workspacecord/core')>();
      return { ...actual, config: { dataDir: tempDir } };
    });
    const { acquireLock, releaseLock, isLocked } = await import('../src/bot-locks.ts');

    acquireLock();
    releaseLock();
    expect(isLocked()).toBe(false);
  });

  it('getLockInfo returns lock data when file exists', async () => {
    vi.doMock('@workspacecord/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@workspacecord/core')>();
      return { ...actual, config: { dataDir: tempDir } };
    });
    const { acquireLock, getLockInfo, releaseLock } = await import('../src/bot-locks.ts');

    acquireLock();
    const info = getLockInfo();

    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.age).toBeGreaterThanOrEqual(0);

    releaseLock();
  });

  it('getLockInfo returns null when no lock file', async () => {
    vi.doMock('@workspacecord/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@workspacecord/core')>();
      return { ...actual, config: { dataDir: tempDir } };
    });
    const { getLockInfo } = await import('../src/bot-locks.ts');

    expect(getLockInfo()).toBeNull();
  });
});
