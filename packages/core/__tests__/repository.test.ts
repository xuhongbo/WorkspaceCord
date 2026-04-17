import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonFileRepository, _setDataDirForTest } from '../src/index.ts';

interface TestEntity extends Record<string, unknown> {
  id: string;
  name: string;
  group?: string;
  count: number;
}

describe('JsonFileRepository', () => {
  let dataDir = '';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wc-repo-'));
    _setDataDirForTest(dataDir);
  });

  afterEach(async () => {
    _setDataDirForTest(null);
    // 给 Repository debounced 写操作一个窗口完成,避免 rmSync 遇到临时文件
    await new Promise((r) => setTimeout(r, 30));
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    vi.restoreAllMocks();
  });

  function make(filename = 'test.json'): JsonFileRepository<TestEntity> {
    return new JsonFileRepository<TestEntity>({
      filename,
      idField: 'id',
      debounceMs: 0,
    });
  }

  it('saves and retrieves by id', async () => {
    const repo = make();
    await repo.init();
    await repo.save({ id: '1', name: 'alpha', count: 1 });
    expect(repo.get('1')).toEqual({ id: '1', name: 'alpha', count: 1 });
    await repo.flush();
  });

  it('survives restart via init() re-reading the file', async () => {
    const repo1 = make('survivor.json');
    await repo1.init();
    await repo1.save({ id: 'a', name: 'before', count: 7 });
    await repo1.flush();

    const repo2 = make('survivor.json');
    await repo2.init();
    expect(repo2.get('a')).toEqual({ id: 'a', name: 'before', count: 7 });
  });

  it('update() merges partial patch and returns new object', async () => {
    const repo = make();
    await repo.init();
    await repo.save({ id: '1', name: 'x', count: 0 });
    const patched = await repo.update('1', { count: 42 });
    expect(patched).toEqual({ id: '1', name: 'x', count: 42 });
    expect(repo.get('1')?.count).toBe(42);
  });

  it('update() returns undefined for missing id without creating it', async () => {
    const repo = make();
    await repo.init();
    const result = await repo.update('missing', { count: 1 });
    expect(result).toBeUndefined();
    expect(repo.size()).toBe(0);
  });

  it('delete() returns false if id not present', async () => {
    const repo = make();
    await repo.init();
    expect(await repo.delete('nope')).toBe(false);
  });

  it('delete() removes the entry and returns true', async () => {
    const repo = make();
    await repo.init();
    await repo.save({ id: '1', name: 'x', count: 0 });
    expect(await repo.delete('1')).toBe(true);
    expect(repo.get('1')).toBeUndefined();
  });

  it('find() filters by where clause', async () => {
    const repo = make();
    await repo.init();
    await repo.save({ id: '1', name: 'a', group: 'g1', count: 1 });
    await repo.save({ id: '2', name: 'b', group: 'g2', count: 2 });
    await repo.save({ id: '3', name: 'c', group: 'g1', count: 3 });

    const g1 = repo.find({ where: { group: 'g1' } });
    expect(g1.map((e) => e.id).sort()).toEqual(['1', '3']);
  });

  it('find() honors limit and sort', async () => {
    const repo = make();
    await repo.init();
    await repo.save({ id: '1', name: 'a', count: 3 });
    await repo.save({ id: '2', name: 'b', count: 1 });
    await repo.save({ id: '3', name: 'c', count: 2 });

    const result = repo.find({
      sort: (a, b) => a.count - b.count,
      limit: 2,
    });
    expect(result.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('saveMany() writes all entities', async () => {
    const repo = make();
    await repo.init();
    await repo.saveMany([
      { id: '1', name: 'a', count: 1 },
      { id: '2', name: 'b', count: 2 },
    ]);
    expect(repo.size()).toBe(2);
  });

  it('clear() empties the repository', async () => {
    const repo = make();
    await repo.init();
    await repo.save({ id: '1', name: 'a', count: 1 });
    await repo.clear();
    expect(repo.size()).toBe(0);
  });

  it('save() rejects entities without string id', async () => {
    const repo = make();
    await repo.init();
    await expect(
      repo.save({ id: 123 as unknown as string, name: 'x', count: 0 }),
    ).rejects.toThrow(/id field/);
  });

  it('parse() is applied on init() and drops invalid records', async () => {
    // pre-write a bad record to disk
    const { Store } = await import('../src/index.ts');
    const store = new Store<unknown[]>('parse-test.json');
    await store.write([
      { id: 'good', name: 'ok', count: 1 },
      { id: 'bad' /* missing count */ },
      'not-an-object',
    ]);

    const repo = new JsonFileRepository<TestEntity>({
      filename: 'parse-test.json',
      idField: 'id',
      debounceMs: 0,
      parse: (raw) => {
        if (typeof raw !== 'object' || raw === null) return undefined;
        const r = raw as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.count !== 'number') {
          return undefined;
        }
        return { id: r.id, name: r.name, count: r.count };
      },
    });
    await repo.init();
    expect(repo.size()).toBe(1);
    expect(repo.get('good')?.count).toBe(1);
  });

  describe('secondary indexes', () => {
    it('find({ where: indexed_field }) goes through O(1) index', async () => {
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'idx.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo.init();
      await repo.save({ id: '1', name: 'a', group: 'g1', count: 1 });
      await repo.save({ id: '2', name: 'b', group: 'g2', count: 2 });
      await repo.save({ id: '3', name: 'c', group: 'g1', count: 3 });

      const g1 = repo.find({ where: { group: 'g1' } });
      expect(g1.map((e) => e.id).sort()).toEqual(['1', '3']);

      const none = repo.find({ where: { group: 'missing' } });
      expect(none).toEqual([]);
    });

    it('update() re-indexes when indexed field changes', async () => {
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'idx-update.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo.init();
      await repo.save({ id: '1', name: 'a', group: 'g1', count: 1 });
      expect(repo.find({ where: { group: 'g1' } })).toHaveLength(1);

      await repo.update('1', { group: 'g2' });
      expect(repo.find({ where: { group: 'g1' } })).toHaveLength(0);
      expect(repo.find({ where: { group: 'g2' } })).toHaveLength(1);
    });

    it('delete() removes entry from indexes', async () => {
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'idx-del.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo.init();
      await repo.save({ id: '1', name: 'a', group: 'g1', count: 1 });
      await repo.delete('1');
      expect(repo.find({ where: { group: 'g1' } })).toHaveLength(0);
    });

    it('reindex() picks up direct mutations on indexed fields', async () => {
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'idx-reindex.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo.init();
      await repo.save({ id: '1', name: 'a', group: 'g1', count: 1 });

      // 直接 mutate(模拟旧代码风格 — 不调用 repo.update)
      const ref = repo.get('1')!;
      ref.group = 'g2';
      // 索引还指向 g1,但 find 的 filter 会校验真实值,返回空
      expect(repo.find({ where: { group: 'g1' } })).toHaveLength(0);
      // g2 索引还没有这条记录,也查不到
      expect(repo.find({ where: { group: 'g2' } })).toHaveLength(0);

      // 调用 reindex 后索引对齐真实值
      repo.reindex('1');
      expect(repo.find({ where: { group: 'g1' } })).toHaveLength(0);
      expect(repo.find({ where: { group: 'g2' } })).toHaveLength(1);
    });

    it('indexes survive init() re-open', async () => {
      const repo1 = new JsonFileRepository<TestEntity>({
        filename: 'idx-restart.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo1.init();
      await repo1.save({ id: '1', name: 'a', group: 'g1', count: 1 });
      await repo1.save({ id: '2', name: 'b', group: 'g1', count: 2 });
      await repo1.flush();

      const repo2 = new JsonFileRepository<TestEntity>({
        filename: 'idx-restart.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo2.init();
      expect(repo2.find({ where: { group: 'g1' } })).toHaveLength(2);
    });

    it('multi-field where: indexed field narrows, non-indexed field filters', async () => {
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'idx-multi.json',
        idField: 'id',
        indexes: [{ field: 'group' }],
        debounceMs: 0,
      });
      await repo.init();
      await repo.save({ id: '1', name: 'a', group: 'g1', count: 1 });
      await repo.save({ id: '2', name: 'a', group: 'g1', count: 2 });
      await repo.save({ id: '3', name: 'b', group: 'g1', count: 3 });

      const result = repo.find({ where: { group: 'g1', name: 'a' } });
      expect(result.map((e) => e.id).sort()).toEqual(['1', '2']);
    });
  });

  describe('debounced writes', () => {
    it('coalesces rapid saves within the debounce window', async () => {
      vi.useFakeTimers();
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'debounce.json',
        idField: 'id',
        debounceMs: 1000,
      });
      await repo.init();

      // 3 rapid saves within 500ms
      await repo.save({ id: '1', name: 'a', count: 1 });
      await repo.save({ id: '2', name: 'b', count: 2 });
      await repo.save({ id: '3', name: 'c', count: 3 });

      // advance time past debounce window
      vi.advanceTimersByTime(1001);
      vi.useRealTimers();
      await repo.flush();

      // reload via a fresh repo to verify persisted state
      const fresh = new JsonFileRepository<TestEntity>({
        filename: 'debounce.json',
        idField: 'id',
        debounceMs: 0,
      });
      await fresh.init();
      expect(fresh.size()).toBe(3);
    });

    it('flush() persists immediately regardless of debounce window', async () => {
      const repo = new JsonFileRepository<TestEntity>({
        filename: 'flush.json',
        idField: 'id',
        debounceMs: 60_000, // very long
      });
      await repo.init();
      await repo.save({ id: '1', name: 'x', count: 1 });
      await repo.flush();

      const fresh = new JsonFileRepository<TestEntity>({
        filename: 'flush.json',
        idField: 'id',
        debounceMs: 0,
      });
      await fresh.init();
      expect(fresh.size()).toBe(1);
    });
  });
});
