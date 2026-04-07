import { mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach } from 'vitest';
import { Store, _setDataDirForTest } from '../src/persistence.ts';

let dataDir = '';

describe('json persistence store', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-persist-'));
    _setDataDirForTest(dataDir);
  });

  it('writes and reads json data', async () => {
    const s = new Store<Record<string, { name: string }>>('projects.json');
    await s.write({ demo: { name: 'demo' } });

    const data = await s.read();
    expect(data?.demo?.name).toBe('demo');
  });

  it('stores files in the configured data dir', async () => {
    const s = new Store<Record<string, { id: string }>>('agents.json');
    await s.write({ a1: { id: 'a1' } });

    const data = await s.read();
    expect(data?.a1?.id).toBe('a1');
    expect(existsSync(join(dataDir, 'agents.json'))).toBe(true);
  });

  it('serializes concurrent writes to the same file', async () => {
    const s = new Store<Record<string, { id: string }>>('projects.json');

    await expect(
      Promise.all([
        s.write({ first: { id: 'first' } }),
        s.write({ second: { id: 'second' } }),
      ]),
    ).resolves.toBeDefined();

    const data = await s.read();
    expect(data).not.toBeNull();
    expect(existsSync(join(dataDir, 'projects.json'))).toBe(true);
  });

  it('recovers after one failed write and allows later writes to proceed', async () => {
    const s = new Store<Record<string, { id: string }>>('broken.json');
    const tmpPath = join(dataDir, 'broken.json.tmp');
    mkdirSync(tmpPath);

    await expect(s.write({ first: { id: 'first' } })).rejects.toBeDefined();

    rmSync(tmpPath, { recursive: true, force: true });

    await expect(s.write({ second: { id: 'second' } })).resolves.toBeUndefined();

    const data = await s.read();
    expect(data?.second?.id).toBe('second');
  });
});
