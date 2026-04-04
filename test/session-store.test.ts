import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach } from 'vitest';
import { SessionStore } from '../src/session/session-store.ts';
import { _setDataDirForTest } from '../src/persistence.ts';

let dataDir = '';

function makeSession(id: string): any {
  return {
    id,
    channelId: `ch-${id}`,
    categoryId: 'cat-1',
    projectName: 'test-project',
    agentLabel: id,
    provider: 'claude' as const,
    type: 'persistent' as const,
    subagentDepth: 0,
    directory: '/tmp/test',
    mode: 'auto' as const,
    verbose: false,
  };
}

describe('SessionStore', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-session-'));
    _setDataDirForTest(dataDir);
  });

  it('saves and loads sessions', async () => {
    const store = new SessionStore('sessions-save.json');
    const session = makeSession('s1');
    await store.saveImmediate(session);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('s1');
  });

  it('deletes a session from disk', async () => {
    const store = new SessionStore('sessions-del.json');
    await store.saveImmediate(makeSession('s1'));
    await store.saveImmediate(makeSession('s2'));

    await store.delete('s1');

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('s2');
  });

  it('does not resurrect a deleted session after flush — saveDebounced → delete → flush', async () => {
    const store = new SessionStore('sessions-race.json');
    const session = makeSession('s-race');

    // 1. saveDebounced puts the session in the buffer (no flush yet)
    store.saveDebounced(session);

    // 2. Delete the session immediately
    await store.delete('s-race');

    // Verify it's gone from disk
    expect(await store.load()).toHaveLength(0);

    // 3. Force flush — the bug would merge the buffer back in, resurrecting it
    await store.flush();

    // 4. The deleted session must NOT exist
    const loaded = await store.load();
    expect(loaded).toHaveLength(0);
    expect(loaded.some((s) => s.id === 's-race')).toBe(false);
  });

  it('allows saveImmediate after delete for the same id', async () => {
    const store = new SessionStore('sessions-recreate.json');
    await store.saveImmediate(makeSession('s1'));
    await store.delete('s1');
    await store.saveImmediate(makeSession('s1'));

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('s1');
  });

  it('does not resurrect a deleted session — saveImmediate → delete → stale flush', async () => {
    const store = new SessionStore('sessions-race2.json');

    // 1. Write session to disk via saveImmediate (also flushes)
    await store.saveImmediate(makeSession('s-race2'));

    // 2. Put a stale entry in the buffer and queue a debounced flush
    store.saveDebounced(makeSession('s-race2'));

    // 3. Manually trigger a flush to simulate an in-flight save
    const flushPromise = store.flush();

    // 4. Delete while the flush is in-flight
    const deletePromise = store.delete('s-race2');

    // 5. Wait for both to settle
    await Promise.all([flushPromise, deletePromise]);

    // 6. The session must NOT exist on disk
    const loaded = await store.load();
    expect(loaded).toHaveLength(0);
    expect(loaded.some((s) => s.id === 's-race2')).toBe(false);
  });
});
