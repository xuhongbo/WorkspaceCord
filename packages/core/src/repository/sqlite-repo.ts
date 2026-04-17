// SQLite 实现的 Repository(基于 Node.js 22.17+ 内置的 `node:sqlite`)
//
// 设计要点:
//   - 单表存储:每个实体类型一张表,schema 为 (id TEXT PRIMARY KEY, data TEXT)
//     额外按用户声明的 index 字段建立二级索引列(generated column),便于 where 查询
//   - `save` 即 UPSERT;`delete` 即 DELETE BY PK;update 先读后合并再 UPSERT
//   - 不做 debounce:SQLite 本身是事务型写入,每次 save 都同步落盘;若需要高并发
//     批量,调用方应使用 `saveMany`(内部用 transaction)
//   - `node:sqlite` 在 Node 22.17+ 稳定(无需 flag),更早版本需要 --experimental-sqlite
//
// 与 JsonFileRepository 的关系:
//   - 实现同一个 Repository<T> 接口,调用方无需改动
//   - 更适合:数据量大、频繁局部更新、有多维索引查询的场景
//   - 不适合:数据量小(< 1000 条)、偶尔全量读写——JSON 更简单

import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDataDir } from '../persistence.ts';
import type { Repository, QueryOptions } from './types.ts';

/**
 * 二级索引声明:字段名 + 值的提取器(默认直接读 `entity[field]`)。
 * 用于加速 `find({ where })` 的 equality 过滤。
 */
export interface SqliteIndexSpec<T> {
  field: keyof T & string;
  /** 可选:如何从实体读出索引值。默认 `(e) => e[field]`。仅支持 string/number/boolean/null。 */
  extract?: (entity: T) => string | number | boolean | null | undefined;
}

export interface SqliteRepoOptions<T> {
  /** 相对 dataDir 的文件名,或绝对路径。内存库用 `':memory:'`。 */
  filename: string;
  /** 表名。若未指定,使用 filename 去扩展名后的 sanitized 值。 */
  tableName?: string;
  idField: keyof T & string;
  /** 要物化为表列的字段,便于 where 查询加速。 */
  indexes?: SqliteIndexSpec<T>[];
  /** 解析函数:对从 DB 读出的对象做校验/规范化;返回 undefined 代表丢弃。 */
  parse?: (raw: unknown) => T | undefined;
}

// 动态导入 node:sqlite,避免在 Node 22.6-22.16 无 flag 运行时直接 crash。
// 用户首次调用 init 时才加载;若平台不支持,抛出可理解的错误。
let sqliteModulePromise: Promise<typeof import('node:sqlite')> | null = null;
function loadSqlite(): Promise<typeof import('node:sqlite')> {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import('node:sqlite').catch((err: unknown) => {
      const message = (err as Error).message ?? String(err);
      throw new Error(
        `node:sqlite is unavailable. Requires Node.js 22.17+ (stable) or Node 22.5–22.16 with --experimental-sqlite. Original error: ${message}`,
      );
    });
  }
  return sqliteModulePromise;
}

type DatabaseSync = InstanceType<typeof import('node:sqlite').DatabaseSync>;

function sanitizeIdentifier(name: string): string {
  // SQLite identifier:允许字母数字下划线;其它替换成下划线。首字符不能是数字。
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** 用双引号包裹标识符,避开 SQLite 保留字(如 `group`, `order`)。 */
function q(identifier: string): string {
  return `"${sanitizeIdentifier(identifier).replace(/"/g, '""')}"`;
}

function resolveDbPath(filename: string): string {
  if (filename === ':memory:') return filename;
  if (filename.startsWith('/') || filename.match(/^[A-Za-z]:\\/)) return filename;
  const dir = getDataDir();
  const full = join(dir, filename);
  const parent = dirname(full);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  return full;
}

function coerceIndexValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  return String(value);
}

export class SqliteRepository<T extends Record<string, unknown>> implements Repository<T> {
  private readonly filename: string;
  private readonly tableName: string;
  private readonly idField: keyof T & string;
  private readonly indexes: SqliteIndexSpec<T>[];
  private readonly parse?: (raw: unknown) => T | undefined;
  private db: DatabaseSync | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: SqliteRepoOptions<T>) {
    this.filename = options.filename;
    this.tableName = sanitizeIdentifier(
      options.tableName ?? options.filename.replace(/\.[^.]+$/, '') ?? 'entities',
    );
    this.idField = options.idField;
    this.indexes = options.indexes ?? [];
    this.parse = options.parse;
  }

  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInit(): Promise<void> {
    const { DatabaseSync } = await loadSqlite();
    const dbPath = resolveDbPath(this.filename);
    const db = new DatabaseSync(dbPath);
    // `:memory:` 不支持 WAL,忽略失败。
    try {
      db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // ignore
    }

    const indexCols = this.indexes
      .map((idx) => `  ${q(idx.field)} TEXT`)
      .join(',\n');
    const tableSql = `CREATE TABLE IF NOT EXISTS ${q(this.tableName)} (
  "id" TEXT PRIMARY KEY,
  "data" TEXT NOT NULL${indexCols ? ',\n' + indexCols : ''}
);`;
    db.exec(tableSql);

    for (const idx of this.indexes) {
      const col = sanitizeIdentifier(idx.field);
      db.exec(
        `CREATE INDEX IF NOT EXISTS ${q('idx_' + this.tableName + '_' + col)} ON ${q(this.tableName)}(${q(idx.field)});`,
      );
    }
    this.db = db;
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('SqliteRepository.init() must be called before use');
    }
    return this.db;
  }

  private parseRow(row: unknown): T | undefined {
    if (!row || typeof row !== 'object') return undefined;
    const { data } = row as { data?: unknown };
    if (typeof data !== 'string') return undefined;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (this.parse) return this.parse(parsed);
      return parsed as T;
    } catch {
      return undefined;
    }
  }

  private extractIndexValues(entity: T): Record<string, string | number | null> {
    const out: Record<string, string | number | null> = {};
    for (const idx of this.indexes) {
      const raw = idx.extract ? idx.extract(entity) : entity[idx.field];
      out[sanitizeIdentifier(idx.field)] = coerceIndexValue(raw);
    }
    return out;
  }

  get(id: string): T | undefined {
    const db = this.requireDb();
    const row = db.prepare(`SELECT "data" FROM ${q(this.tableName)} WHERE "id" = ?`).get(id);
    return row ? this.parseRow(row) : undefined;
  }

  find(options: QueryOptions<T> = {}): T[] {
    const db = this.requireDb();
    const whereClauses: string[] = [];
    const params: Array<string | number | null> = [];

    if (options.where) {
      for (const [field, rawValue] of Object.entries(options.where) as Array<
        [keyof T & string, unknown]
      >) {
        const indexSpec = this.indexes.find((i) => i.field === field);
        const coerced = coerceIndexValue(rawValue);
        if (indexSpec) {
          if (coerced === null) {
            whereClauses.push(`${q(field)} IS NULL`);
          } else {
            whereClauses.push(`${q(field)} = ?`);
            params.push(coerced);
          }
        } else {
          // 非索引字段:用 SQLite 的 JSON 函数按需过滤。
          if (coerced === null) {
            whereClauses.push(`json_extract("data", ?) IS NULL`);
            params.push(`$.${field}`);
          } else {
            whereClauses.push(`json_extract("data", ?) = ?`);
            params.push(`$.${field}`);
            params.push(coerced);
          }
        }
      }
    }

    const sql = `SELECT "data" FROM ${q(this.tableName)}${
      whereClauses.length ? ' WHERE ' + whereClauses.join(' AND ') : ''
    }`;
    const rows = db.prepare(sql).all(...params);
    let result: T[] = [];
    for (const row of rows) {
      const parsed = this.parseRow(row);
      if (parsed) result.push(parsed);
    }

    if (options.sort) result.sort(options.sort);
    if (options.limit !== undefined) result = result.slice(0, options.limit);
    return result;
  }

  getAll(): T[] {
    return this.find();
  }

  size(): number {
    const db = this.requireDb();
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${q(this.tableName)}`).get() as {
      n: number;
    };
    return row.n;
  }

  async save(entity: T): Promise<void> {
    const db = this.requireDb();
    const id = entity[this.idField];
    if (typeof id !== 'string') {
      throw new Error(
        `SqliteRepository.save: id field "${this.idField}" missing or non-string`,
      );
    }
    const indexValues = this.extractIndexValues(entity);
    const indexCols = Object.keys(indexValues);
    const colsSql = ['"id"', '"data"', ...indexCols.map(q)].join(', ');
    const placeholders = Array(2 + indexCols.length).fill('?').join(', ');
    const updateAssignments = ['"data"', ...indexCols.map(q)]
      .map((col) => `${col} = excluded.${col}`)
      .join(', ');
    const sql = `INSERT INTO ${q(this.tableName)} (${colsSql}) VALUES (${placeholders})
      ON CONFLICT("id") DO UPDATE SET ${updateAssignments}`;
    const params: Array<string | number | null> = [id, JSON.stringify(entity)];
    for (const key of indexCols) params.push(indexValues[key]);
    db.prepare(sql).run(...params);
  }

  async saveMany(entities: T[]): Promise<void> {
    if (entities.length === 0) return;
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      for (const entity of entities) {
        await this.save(entity);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch } as T;
    await this.save(next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const db = this.requireDb();
    const info = db.prepare(`DELETE FROM ${q(this.tableName)} WHERE "id" = ?`).run(id);
    return info.changes > 0;
  }

  async clear(): Promise<void> {
    const db = this.requireDb();
    db.exec(`DELETE FROM ${q(this.tableName)}`);
  }

  async flush(): Promise<void> {
    // node:sqlite 每次 run 都同步写入 WAL;flush 即 checkpoint。
    const db = this.db;
    if (!db) return;
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // 某些 journal 模式下 checkpoint 不适用,忽略。
    }
  }

  /** 关闭数据库连接。主要供测试用;生产可交给进程退出。 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
