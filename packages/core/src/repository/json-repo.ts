// JSON 文件实现的 Repository
// 替代旧的 `Store<T[]>` + 业务层维护数组和索引的模式:
//   - 内存中用 Map 按 id 索引,O(1) 读写
//   - 可选二级索引(如 sessions 的 categoryId、providerSessionId)
//   - 写操作 debounce 1s,期间合并后一次性重写整个 JSON 文件
//   - `flush()` 立即强制落盘,用于 shutdown
//
// 未来切换 SQLite 时,只需实现同一个 Repository 接口,调用点无需改动。

import { Store } from '../persistence.ts';
import type { Repository, QueryOptions } from './types.ts';

const DEFAULT_DEBOUNCE_MS = 1000;

export interface JsonRepoOptions<T> {
  filename: string;
  idField: keyof T & string;
  /** 可选:从原始 unknown 解析为 T;失败返回 undefined,仓储将丢弃此条记录。 */
  parse?: (raw: unknown, index: number) => T | undefined;
  /** debounce 毫秒数;0 表示立即写。默认 1000ms。 */
  debounceMs?: number;
}

export class JsonFileRepository<T extends Record<string, unknown>> implements Repository<T> {
  private readonly store: Store<unknown>;
  private readonly idField: keyof T & string;
  private readonly parse?: (raw: unknown, index: number) => T | undefined;
  private readonly debounceMs: number;
  private readonly entries = new Map<string, T>();
  private saveTimer: NodeJS.Timeout | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(options: JsonRepoOptions<T>) {
    this.store = new Store<unknown>(options.filename);
    this.idField = options.idField;
    this.parse = options.parse;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
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
    }
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  find(options: QueryOptions<T> = {}): T[] {
    let result = Array.from(this.entries.values());
    if (options.where) {
      const filters = Object.entries(options.where) as Array<[keyof T, unknown]>;
      result = result.filter((item) => filters.every(([key, value]) => item[key] === value));
    }
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
    this.entries.set(id, entity);
    this.scheduleWrite();
  }

  async saveMany(entities: T[]): Promise<void> {
    for (const entity of entities) {
      const id = entity[this.idField];
      if (typeof id !== 'string') continue;
      this.entries.set(id, entity);
    }
    this.scheduleWrite();
  }

  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    const current = this.entries.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch } as T;
    this.entries.set(id, next);
    this.scheduleWrite();
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.entries.delete(id);
    if (existed) this.scheduleWrite();
    return existed;
  }

  async clear(): Promise<void> {
    this.entries.clear();
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
    const snapshot = Array.from(this.entries.values());
    try {
      await this.store.write(snapshot);
    } catch (err) {
      console.error(`[JsonFileRepository] write failed: ${(err as Error).message}`);
    }
  }
}
