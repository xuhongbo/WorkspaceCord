import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setDataDirForTest } from '../src/persistence.ts';

vi.mock('../src/providers/index.ts', () => ({
  ensureProvider: vi.fn(async () => undefined),
}));

vi.mock('../src/config.ts', () => ({
  config: {
    defaultMode: 'auto',
  },
}));

describe('thread-manager 本地感知字段持久化', () => {
  let dataDir = '';
  let workDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-sessions-'));
    workDir = mkdtempSync(join(tmpdir(), 'workspacecord-work-'));
    _setDataDirForTest(dataDir);
  });

  afterEach(() => {
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('会把本地感知字段写入 sessions.json', async () => {
    const threadManager = await import('../src/thread-manager.ts');
    const session = await threadManager.createSession({
      channelId: 'channel-1',
      categoryId: 'category-1',
      projectName: 'demo',
      agentLabel: 'demo-session',
      provider: 'codex',
      providerSessionId: 'provider-1',
      directory: workDir,
      type: 'persistent',
      discoverySource: 'codex-log',
      remoteHumanControl: true,
    });

    threadManager.updateSession(session.id, {
      lastObservedState: 'thinking_started',
      lastObservedEventKey: 'event_msg:task_started',
      lastObservedAt: 123456789,
      lastObservedCwd: workDir,
      activeHumanGateId: 'gate-1',
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const raw = readFileSync(join(dataDir, 'sessions.json'), 'utf8');
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      discoverySource: 'codex-log',
      remoteHumanControl: true,
      lastObservedState: 'thinking_started',
      lastObservedEventKey: 'event_msg:task_started',
      lastObservedAt: 123456789,
      lastObservedCwd: workDir,
      activeHumanGateId: 'gate-1',
    });
  });
});
