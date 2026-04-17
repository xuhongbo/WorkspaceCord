// Repository 抽象 — P4 引入的存储层接口
//
// 设计目标:
//   1. 解耦业务代码与具体存储(JSON / SQLite / 未来的其它后端)
//   2. 支持按 ID 的部分更新(不再每次重写整个数组)
//   3. 支持按二级字段查询(byCategory / byProviderSession)避免业务层维护 Map
//   4. 支持原子批处理(createSession + initGate 同一事务)
//
// 当前默认实现是 `JsonFileRepository<T>`(见 json-repo.ts)。未来的 SQLite 实现
// 应遵循同一接口:每个实体有 id 列 + 若干索引列,`save` 即 UPSERT,`delete` 即
// DELETE BY ID。native 模块构建受限的环境会继续走 JSON,用户只需切换
// implementation 工厂。

export interface RepositoryEntity {
  /** 主键字段名,用于 UPSERT / 索引构建。 */
  readonly idField: string;
}

export interface QueryOptions<T> {
  /** 简单字段等值过滤。 */
  where?: Partial<T>;
  /** 可选排序;接受自定义比较函数,便于复合排序。 */
  sort?: (a: T, b: T) => number;
  /** 结果条数限制。 */
  limit?: number;
}

/**
 * 通用仓储契约。
 * - 读操作纯函数(no side effect)
 * - 写操作返回 Promise,允许 debounce / 批处理实现内部异步
 * - 所有错误通过 rejected Promise 抛出,调用方用 try/catch 捕获
 */
export interface Repository<T extends { [key: string]: unknown }> {
  /** 初始化:加载已有数据、构建索引。启动时调用一次。 */
  init(): Promise<void>;

  /** 按主键获取单条。 */
  get(id: string): T | undefined;

  /** 按条件查询;无 where 则返回所有。 */
  find(options?: QueryOptions<T>): T[];

  /** 获取全部条目(等价于 find({}))。 */
  getAll(): T[];

  /** 记录数。 */
  size(): number;

  /** UPSERT:按主键存在即更新,不存在即插入。 */
  save(entity: T): Promise<void>;

  /** 批量 UPSERT。 */
  saveMany(entities: T[]): Promise<void>;

  /** 部分更新:合并字段后重写。返回更新后的完整对象或 undefined(不存在时)。 */
  update(id: string, patch: Partial<T>): Promise<T | undefined>;

  /** 按主键删除。返回是否删除了记录。 */
  delete(id: string): Promise<boolean>;

  /** 清空全部;慎用,一般用于测试或数据迁移。 */
  clear(): Promise<void>;

  /** 强制把挂起的写操作 flush 到存储介质;进程退出或关键节点调用。 */
  flush(): Promise<void>;
}
