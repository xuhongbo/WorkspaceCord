// Repository 抽象公共出口
export type { Repository, QueryOptions, RepositoryEntity } from './types.ts';
export {
  JsonFileRepository,
  type JsonRepoOptions,
  type JsonIndexSpec,
} from './json-repo.ts';
export {
  SqliteRepository,
  type SqliteRepoOptions,
  type SqliteIndexSpec,
} from './sqlite-repo.ts';
