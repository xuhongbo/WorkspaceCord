# Plan 1/4: 全局配置 — Configstore 替换 .env

> **大前提：** workspacecord 的目标形态是全局安装的命令行工具（`npm install -g workspacecord`），以后台常驻服务运行。本计划是实现这一目标的第一步 — 将配置从项目目录的 .env 迁移到全局位置。

> **状态更新（2026-03-31）：方案已演化。**
>
> 该计划的“全局配置”目标已经落地，但文中的命令面仍保留了历史术语：
>
> - 命令名已从 `workspacecord` 演化为 `workspacecord`
> - 文中提到的旧 `/session new`、`/session resume` 只是当时的调用面假设；当前产品已经演化为 `/project setup` + `/agent spawn`
>
> 这不影响本计划的核心结论：配置已迁移到全局存储，目录白名单与默认目录模型已经退出主路径。

**Goal:** 将机器人配置从 cwd/.env 迁移到 Configstore 全局存储，同时将数据目录从 cwd/.discord-friends/ 迁移到 ~/.workspacecord/

**Architecture:** 引入 Configstore 作为全局配置存储，重写 config.ts 从 Configstore 读取而非 process.env，重写 setup.ts 写入 Configstore 而非 .env 文件，更新 persistence.ts 使用固定全局路径，更新 cli.ts 入口移除 .env 检查，更新 daemon.ts 移除 WorkingDirectory 依赖。这样后续本地会话同步可稳定读取全局项目注册表与 JSONL 状态，而不依赖当前工作目录。

**Tech Stack:** configstore (npm), @clack/prompts (已有), vitest (已有)

**Spec:** `docs/superpowers/specs/2026-03-26-global-config-and-project-mounting-design.md` §配置设计

---

## File Structure

| Action | Path                         | Responsibility                                     |
| ------ | ---------------------------- | -------------------------------------------------- |
| Create | `src/global-config.ts`       | Configstore 读写封装，校验，遮罩显示               |
| Modify | `src/config.ts`              | 从 global-config 读取替代 dotenv                   |
| Modify | `src/types.ts`               | 移除 Config.allowedPaths / Config.defaultDirectory |
| Modify | `src/persistence.ts`         | DATA_DIR 改为 ~/.workspacecord/                        |
| Modify | `src/cli.ts`                 | 新增 config 子命令，移除 .env 检查                 |
| Modify | `src/setup.ts`               | 写入 Configstore 替代 .env                         |
| Modify | `src/daemon.ts`              | WorkingDirectory 改为 ~/.workspacecord                 |
| Modify | `src/session-manager.ts`     | 移除 isPathAllowed 调用                            |
| Modify | `src/command-handlers.ts`    | 移除 config.defaultDirectory 引用                  |
| Modify | `src/agent-router.ts`        | 移除 config.defaultDirectory 引用                  |
| Modify | `src/utils.ts`               | 移除 isPathAllowed 函数                            |
| Create | `test/global-config.test.ts` | 全局配置读写测试                                   |

由于计划内容较长，已拆分为 9 个 Task，完整内容见下方。每个 Task 遵循 TDD 流程（测试先行）并在完成后独立 commit。

### Task 1: 安装 Configstore 并创建全局配置模块

**Files:**

- Create: `src/global-config.ts`
- Create: `test/global-config.test.ts`

- [ ] **Step 1: 安装 configstore**

```bash
pnpm add configstore
pnpm add -D @types/configstore
```

- [ ] **Step 2: 写测试 `test/global-config.test.ts`**

测试覆盖：读写、删除、列举、路径输出、敏感值遮罩、值校验（CODEX_SANDBOX_MODE / CODEX_APPROVAL_POLICY / ALLOW_ALL_USERS / RATE_LIMIT_MS）、未知 key 拒绝。

使用 `vi.mock('configstore')` mock 底层存储为内存 Map。

- [ ] **Step 3: 运行测试确认失败**

```bash
pnpm test -- test/global-config.test.ts
```

Expected: FAIL — module `../src/global-config.ts` not found

- [ ] **Step 4: 实现 `src/global-config.ts`**

导出：

- `SENSITIVE_KEYS`: Set — 包含 `DISCORD_TOKEN`
- `VALID_KEYS`: Set — 所有合法配置 key
- `validateConfigValue(key, value)`: 返回 `string | null`（null 表示合法）
- `maskSensitive(key, value)`: 敏感值保留首尾 4 字符，中间替换为 `********`
- `getConfigValue(key)`: 读取
- `setConfigValue(key, value)`: 写入
- `deleteConfigValue(key)`: 删除
- `getAllConfig()`: 返回全部
- `getConfigPath()`: 返回文件路径

内部使用 `new Configstore('workspacecord', {}, { globalConfigPath: true })`。

- [ ] **Step 5: 运行测试确认通过**

```bash
pnpm test -- test/global-config.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/global-config.ts test/global-config.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add global-config module with Configstore"
```

### Task 2: 重写 config.ts 从 Configstore 读取

**Files:**

- Modify: `src/config.ts`
- Modify: `src/types.ts:168-181`

- [ ] **Step 1: 更新 Config 类型**

从 `Config` interface 中移除 `allowedPaths: string[]` 和 `defaultDirectory: string`。

- [ ] **Step 2: 重写 config.ts**

- 移除 `import 'dotenv/config'`
- 改为 `import { getConfigValue } from './global-config.ts'`
- `getRequired(key)` 内部调用 `getConfigValue(key)`，缺失时提示 `workspacecord config setup`
- 移除 `allowedPaths` 和 `defaultDirectory` 的读取
- 移除 `allowedPaths` 相关的启动日志

- [ ] **Step 3: 运行类型检查**

```bash
pnpm typecheck
```

Expected: 编译错误指向引用 `config.allowedPaths` 和 `config.defaultDirectory` 的文件（Task 3 修复）。

注意：此 Task 暂不 commit，与 Task 3 合并 commit 以保证代码始终可编译。

### Task 3: 清理 allowedPaths 和 defaultDirectory 引用

**Files:**

- Modify: `src/session-manager.ts:171`
- Modify: `src/command-handlers.ts:219,444,702`
- Modify: `src/agent-router.ts:139`
- Modify: `src/utils.ts:39-50`

- [ ] **Step 1: session-manager.ts — 移除 isPathAllowed 调用**

删除 `isPathAllowed(resolvedDir, config.allowedPaths)` 检查及其 import。

- [ ] **Step 2: command-handlers.ts — 移除 config.defaultDirectory**

三处引用：

- `/session new` 的 directory fallback → 改为 directory 必填，缺失时报错（临时方案，Plan 3 会重构为 project 选择）
- `/session resume` 的 directory fallback → 同上
- `/session sync` 的 directory fallback → 跳过无 directory metadata 的频道

- [ ] **Step 3: agent-router.ts — 移除 config.defaultDirectory**

`resolveChannelContext` 的 fallback 从 `config.defaultDirectory` 改为抛出错误（频道必须归属于某个项目，Plan 3 会进一步保证这一点）。移除 config import（如果不再使用）。

- [ ] **Step 4: utils.ts — 删除 isPathAllowed 函数**

- [ ] **Step 5: 运行类型检查和测试**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 6: Commit（包含 Task 2 的改动）**

```bash
git add src/config.ts src/types.ts src/session-manager.ts src/command-handlers.ts src/agent-router.ts src/utils.ts
git commit -m "refactor: rewrite config to Configstore, remove allowedPaths and defaultDirectory"
```

### Task 4: 迁移 persistence.ts 到全局路径

**Files:**

- Modify: `src/persistence.ts`

- [ ] **Step 1: 修改 DATA_DIR**

```typescript
// 原来
const DATA_DIR = join(process.cwd(), '.discord-friends');
// 改为
import { homedir } from 'node:os';
const DATA_DIR = join(homedir(), '.workspacecord');
```

- [ ] **Step 2: 运行测试**

```bash
pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add src/persistence.ts
git commit -m "refactor: move data storage to ~/.workspacecord/"
```

### Task 5: 新增 CLI config 子命令

**Files:**

- Modify: `src/cli.ts`

- [ ] **Step 1: 重写 cli.ts**

- 新增 `case 'config'` 分支，动态 import `config-cli.ts`
- 移除 `case 'start'` / `case undefined` 中的 `.env` 文件存在性检查
- 更新 help 文本，列出 config 子命令
- 保留 `setup` 作为 `config setup` 的别名

- [ ] **Step 2: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add config subcommand to CLI, remove .env check"
```

### Task 6: 实现 config-cli.ts 命令处理

**Files:**

- Create: `src/config-cli.ts`

- [ ] **Step 1: 实现 config-cli.ts**

导出 `handleConfig(args: string[])`，处理子命令：

- `setup` → 调用 `setup.ts` 的 `runSetup()`
- `get <key>` → 读取并输出（敏感值遮罩）
- `set <key> <value>` → 校验后写入
- `unset <key>` → 删除
- `list` → 列出所有（敏感值遮罩）
- `path` → 输出文件路径
- 无参数 → 显示 help

- [ ] **Step 2: Commit**

```bash
git add src/config-cli.ts
git commit -m "feat: implement config CLI commands (get/set/unset/list/path)"
```

### Task 7: 重写 setup.ts 写入 Configstore

**Files:**

- Modify: `src/setup.ts`

- [ ] **Step 1: 重写 setup.ts**

- 移除 `loadExistingEnv()` 和 `writeEnvFile()`
- 改为从 `global-config.ts` 的 `getConfigValue` / `setConfigValue` 读写
- 移除 ALLOWED_PATHS 步骤（Step 7）
- 移除 DEFAULT_DIRECTORY 步骤（Step 8）
- 移除 Codex SDK 安装步骤（Step 10，已是 optionalDependencies）
- 保留 daemon install 步骤

- [ ] **Step 2: 手动测试**

```bash
node --experimental-strip-types src/cli.ts config setup
node --experimental-strip-types src/cli.ts config list
```

- [ ] **Step 3: Commit**

```bash
git add src/setup.ts
git commit -m "feat: rewrite setup wizard to use Configstore"
```

### Task 8: 更新 daemon.ts 移除 .env 依赖

**Files:**

- Modify: `src/daemon.ts`

- [ ] **Step 1: 修改 WorkingDirectory**

`install` 函数中的 `workDir` 从 `process.cwd()` 改为 `join(homedir(), '.workspacecord')`。

`generateMacPlist` 和 `generateLinuxService` 中的 `WorkingDirectory` 同步更新。

移除 help 文本中的 "Run from the directory containing your .env file."。

- [ ] **Step 2: Commit**

```bash
git add src/daemon.ts
git commit -m "refactor: daemon uses ~/.workspacecord as WorkingDirectory"
```

### Task 9: 移除 dotenv 依赖并清理

**Files:**

- Modify: `package.json`
- Modify: `src/index.ts`

- [ ] **Step 1: 移除 dotenv**

```bash
pnpm remove dotenv
```

- [ ] **Step 2: 简化 index.ts**

移除 `.env` 文件存在性检查，直接启动 bot。

- [ ] **Step 3: 运行完整测试和类型检查**

```bash
pnpm test && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/index.ts
git commit -m "chore: remove dotenv dependency, simplify entry point"
```
