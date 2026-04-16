import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setDataDirForTest } from '@workspacecord/core';

vi.mock('@workspacecord/providers', () => ({
  ensureProvider: vi.fn(async () => undefined),
}));

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/core')>();
  return {
    ...actual,
    config: { defaultMode: 'auto' },
  };
});

describe('SessionContext supervisor (P5)', () => {
  let dataDir = '';
  let workDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wc-sessionctx-'));
    workDir = mkdtempSync(join(tmpdir(), 'wc-work-'));
    _setDataDirForTest(dataDir);
  });

  afterEach(() => {
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns undefined for unknown session', async () => {
    const { getSessionContext } = await import('../src/session-context.ts');
    expect(getSessionContext('nope')).toBeUndefined();
  });

  it('wraps an existing session with session + projection', async () => {
    const registry = await import('../src/session-registry.ts');
    const session = await registry.createSession({
      channelId: 'ch-1',
      categoryId: 'cat-1',
      projectName: 'demo',
      agentLabel: 'demo',
      provider: 'claude',
      directory: workDir,
      type: 'persistent',
    });

    const { getSessionContext } = await import('../src/session-context.ts');
    const ctx = getSessionContext(session.id);
    expect(ctx).toBeDefined();
    expect(ctx!.session.id).toBe(session.id);
    expect(ctx!.projection).toBeDefined();
    expect(ctx!.controller).toBeUndefined();
  });

  it('stable identity: repeated get() returns same context instance', async () => {
    const registry = await import('../src/session-registry.ts');
    const session = await registry.createSession({
      channelId: 'ch-2',
      categoryId: 'cat-2',
      projectName: 'demo',
      agentLabel: 'demo-2',
      provider: 'claude',
      directory: workDir,
      type: 'persistent',
    });

    const { getSessionContext } = await import('../src/session-context.ts');
    const a = getSessionContext(session.id)!;
    const b = getSessionContext(session.id)!;
    expect(a).toBe(b);
  });

  it('refresh() pulls latest controller and projection', async () => {
    const registry = await import('../src/session-registry.ts');
    const session = await registry.createSession({
      channelId: 'ch-3',
      categoryId: 'cat-3',
      projectName: 'demo',
      agentLabel: 'demo-3',
      provider: 'claude',
      directory: workDir,
      type: 'persistent',
    });

    const { getSessionContext } = await import('../src/session-context.ts');
    const ctx = getSessionContext(session.id)!;
    expect(ctx.controller).toBeUndefined();

    const ac = new AbortController();
    registry.setSessionController(session.id, ac);
    ctx.refresh();
    expect(ctx.controller).toBe(ac);
  });

  it('requireSessionContext throws on missing session', async () => {
    const { requireSessionContext } = await import('../src/session-context.ts');
    expect(() => requireSessionContext('does-not-exist')).toThrow(/missing/);
  });

  it('supervisor.all() lists live contexts', async () => {
    const registry = await import('../src/session-registry.ts');
    const s1 = await registry.createSession({
      channelId: 'c-a',
      categoryId: 'cat-a',
      projectName: 'p',
      agentLabel: 'a',
      provider: 'claude',
      directory: workDir,
      type: 'persistent',
    });
    const s2 = await registry.createSession({
      channelId: 'c-b',
      categoryId: 'cat-b',
      projectName: 'p',
      agentLabel: 'b',
      provider: 'claude',
      directory: workDir,
      type: 'persistent',
    });

    const { sessionSupervisor, getSessionContext } = await import('../src/session-context.ts');
    getSessionContext(s1.id);
    getSessionContext(s2.id);
    const all = sessionSupervisor.all();
    expect(all.map((c) => c.sessionId).sort()).toEqual([s1.id, s2.id].sort());
  });

  it('supervisor.release() drops a context', async () => {
    const registry = await import('../src/session-registry.ts');
    const s = await registry.createSession({
      channelId: 'c-rel',
      categoryId: 'cat-rel',
      projectName: 'p',
      agentLabel: 'r',
      provider: 'claude',
      directory: workDir,
      type: 'persistent',
    });

    const { sessionSupervisor, getSessionContext } = await import('../src/session-context.ts');
    getSessionContext(s.id);
    expect(sessionSupervisor.all()).toHaveLength(1);

    sessionSupervisor.release(s.id);
    expect(sessionSupervisor.all()).toHaveLength(0);
  });
});
