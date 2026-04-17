// JSON 文件实现的 Repository
// 替代旧的 `Store<T[]>` + 业务层维护数组和索引的模式:
//   - 内存中用 Map 按 id 索引,O(1) 读写
//   - 可选二级索引:声明 indexes=[{field}] 后,按该字段的 equality where 过滤走 O(1)
//   - 写操作 debounce 1s,期间合并后一次性重写整个 JSON 文件
//   - `flush()` 立即强制落盘,用于 shutdown
//
// 未来切换 SQLite 时,只需实现同一个 Repository 接口,调用点无需改动。

import { Store } from '../persistence.ts';
import type { Repository, QueryOptions } from './types.ts';

const DEFAULT_DEBOUNCE_MS = 1000;

export interface JsonIndexSpec<T> {
  field: keyof T & string;
  /** 可选:如何从实体读出索引值。默认 `(e) => e[field]`。 */
  extract?: (entity: T) => unknown;
}

export interface JsonRepoOptions<T> {
  filename: string;
  idField: keyof T & string;
  /**
   * 二级索引声明。被索引的字段在 `find({ where })` 里走 O(1),
   * 其它字段仍然走 O(n) 线性扫描。
   */
  indexes?: JsonIndexSpec<T>[];
  /** 可选:从原始 unknown 解析为 T;失败返回 undefined,仓储将丢弃此条记录。 */
  parse?: (raw: unknown, index: number) => T | undefined;
  /**
   * 可选:写盘前对 entity 做变换(例如去掉 runtime-only 字段)。
   * 不影响 in-memory 的 T(调用方仍按完整 T 读写),只影响 JSON 输出。
   */
  serialize?: (entity: T) => unknown;
  /** debounce 毫秒数;0 表示立即写。默认 1000ms。 */
  debounceMs?: number;
}

/** 内部:把索引值归一成可用作 Map key 的字符串(null/undefined 用独立 sentinel)。 */
const NULL_INDEX_KEY = '__json_repo_null__';
function indexKey(value: unknown): string {
  if (value === undefined || value === null) return NULL_INDEX_KEY;
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value ? 1 : 0}`;
  return `o:${String(value)}`;
}

export class JsonFileRepository<T extends Record<string, unknown>> implements Repository<T> {
  private readonly store: Store<unknown>;
  private readonly idField: keyof T & string;
  private readonly indexes: JsonIndexSpec<T>[];
  private readonly parse?: (raw: unknown, index: number) => T | undefined;
  private readonly serialize?: (entity: T) => unknown;
  private readonly debounceMs: number;
  private readonly entries = new Map<string, T>();
  /** 索引字段 → 索引值 key → 持有该值的主键集合 */
  private readonly indexMaps = new Map<string, Map<string, Set<string>>>();
  private saveTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(options: JsonRepoOptions<T>) {
    this.store = new Store<unknown>(options.filename);
    this.idField = options.idField;
    this.indexes = options.indexes ?? [];
    this.parse = options.parse;
    this.serialize = options.serialize;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    for (const idx of this.indexes) this.indexMaps.set(idx.field, new Map());
  }

  async init(): Promise<void> {
    const raw = await this.store.read();
    if (!Array.isArray(raw)) return;
    for (let i = 0; i < raw.length; i++) {
      const parsed = this.parse ? this.parse(raw[i], i) : (raw[i] as T);
      if (!parsed) continue;
      const id = parsed[this.idField];
      if (typeof id !== 'string') continue;
      this.entries.set(id, parsed);
      this.addToIndexes(id, parsed);
    }
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  find(options: QueryOptions<T> = {}): T[] {
    let candidates: Iterable<T>;

    if (options.where) {
      const whereEntries = Object.entries(options.where) as Array<[keyof T & string, unknown]>;
      const indexedEntry = whereEntries.find(([field]) =>
        this.indexMaps.has(field),
      );

      if (indexedEntry) {
        // 用第一个命中索引字段作为起始集合,其余字段线性过滤
        const [field, value] = indexedEntry;
        const idSet = this.indexMaps.get(field)?.get(indexKey(value));
        if (!idSet || idSet.size === 0) return [];
        const seed: T[] = [];
        for (const id of idSet) {
          const entity = this.entries.get(id);
          if (entity) seed.push(entity);
        }
        candidates = seed;
      } else {
        candidates = this.entries.values();
      }

      let result = Array.from(candidates).filter((item) =>
        whereEntries.every(([key, value]) => item[key] === value),
      );
      if (options.sort) result.sort(options.sort);
      if (options.limit !== undefined) result = result.slice(0, options.limit);
      return result;
    }

    let result = Array.from(this.entries.values());
    if (options.sort) result.sort(options.sort);
    if (options.limit !== undefined) result = result.slice(0, options.limit);
    return result;
  }

  getAll(): T[] {
    return Array.from(this.entries.values());
  }

  size(): number {
    return this.entries.size;
  }

  async save(entity: T): Promise<void> {
    const id = entity[this.idField];
    if (typeof id !== 'string') {
      throw new Error(`Repository.save: id field "${this.idField}" missing or non-string`);
    }
    const existing = this.entries.get(id);
    if (existing && existing !== entity) {
      // 不同对象 → 先从索引里移除旧的
      this.removeFromIndexes(id, existing);
    } else if (existing) {
      // 同一引用被直接 mutate 后再 save:重建索引以防索引字段变了
      this.removeFromIndexes(id, existing);
    }
    this.entries.set(id, entity);
    this.addToIndexes(id, entity);
    this.scheduleWrite();
  }

  async saveMany(entities: T[]): Promise<void> {
    for (const entity of entities) {
      const id = entity[this.idField];
      if (typeof id !== 'string') continue;
      const existing = this.entries.get(id);
      if (existing) this.removeFromIndexes(id, existing);
      this.entries.set(id, entity);
      this.addToIndexes(id, entity);
    }
    this.scheduleWrite();
  }

  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    const current = this.entries.get(id);
    if (!current) return undefined;
    this.removeFromIndexes(id, current);
    const next = { ...current, ...patch } as T;
    this.entries.set(id, next);
    this.addToIndexes(id, next);
    this.scheduleWrite();
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.entries.get(id);
    if (!existing) return false;
    this.removeFromIndexes(id, existing);
    this.entries.delete(id);
    this.scheduleWrite();
    return true;
  }

  async clear(): Promise<void> {
    this.entries.clear();
    for (const map of this.indexMaps.values()) map.clear();
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) {
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.writeNow());
    }
    await this.writeChain;
  }

  /**
   * 调用方在直接 mutate entity 字段后,显式触发一次索引重建 + 持久化调度。
   * 典型场景:session 对象被多处代码引用,就地改 providerSessionId 后需要重建二级索引。
   */
  reindex(id: string): void {
    const entity = this.entries.get(id);
    if (!entity) return;
    this.removeFromIndexes(id, entity);
    this.addToIndexes(id, entity);
    this.scheduleWrite();
  }

  // ─── Index maintenance ────────────────────────────────────────────────────

  private addToIndexes(id: string, entity: T): void {
    for (const idx of this.indexes) {
      const raw = idx.extract ? idx.extract(entity) : entity[idx.field];
      const key = indexKey(raw);
      const map = this.indexMaps.get(idx.field);
      if (!map) continue;
      let set = map.get(key);
      if (!set) {
        set = new Set();
        map.set(key, set);
      }
      set.add(id);
    }
  }

  private removeFromIndexes(id: string, entity: T): void {
    for (const idx of this.indexes) {
      const raw = idx.extract ? idx.extract(entity) : entity[idx.field];
      const key = indexKey(raw);
      const map = this.indexMaps.get(idx.field);
      if (!map) continue;
      const set = map.get(key);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) map.delete(key);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private scheduleWrite(): void {
    this.dirty = true;
    if (this.debounceMs === 0) {
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.writeNow());
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.dirty) return;
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.writeNow());
    }, this.debounceMs);
    this.saveTimer.unref?.();
  }

  private async writeNow(): Promise<void> {
    this.dirty = false;
    const snapshot: unknown[] = [];
    for (const entity of this.entries.values()) {
      snapshot.push(this.serialize ? this.serialize(entity) : entity);
    }
    try {
      await this.store.write(snapshot);
    } catch (err) {
      console.error(`[JsonFileRepository] write failed: ${(err as Error).message}`);
    }
  }
}
