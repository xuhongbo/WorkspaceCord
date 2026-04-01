# Plan 4/4: 本地会话自动同步 — Claude + Codex 轮询发现

> **大前提：** workspacecord 的目标形态是全局安装的命令行工具（`npm install -g workspacecord`），以后台常驻服务运行。本计划实现核心差异化能力 — 用户在终端用 `claude` 或 `codex` 命令创建的会话自动出现在 Discord 中，实现"本地编码、远程可见"的体验。

> **状态更新（2026-03-31）：方案已演化。**
>
> 本地会话同步能力已经落地，但实现细节相较本计划有两点演化：
>
> - 当前代码使用持久会话模型来承接同步结果，而不是保留一套单独的“同步会话”抽象
> - 当前只同步已经完成 Discord 项目绑定的已挂载项目；也就是项目不仅要本地注册，还要有已绑定的 Discord 分类
>
> 因而，这份计划可继续作为“发现与过滤策略”的历史说明，但不能再视为当前实现的逐行蓝图。

**Goal:** 自动发现本地 CLI 创建的 Claude/Codex 会话，在对应项目的 Discord 分类下创建频道，支持通过 Discord 消息 resume 对话

**Architecture:** 新增 `session-sync.ts` 模块，在 bot 启动后以 30s 间隔轮询。Claude 通过 SDK `listSessions({ dir })` API 发现；Codex 通过读取 `session_index.jsonl` 拿到候选会话，再按 `id` 在 `sessions/**/*.jsonl` 中定位真实会话文件，读取首条 `session_meta.payload.cwd`，仅同步 `cwd` 位于已挂载项目根目录之下的会话。发现新会话后在 Discord 创建频道并注册到 `sessions.json`。第一阶段不同步历史消息。

**Spec:** `docs/superpowers/specs/2026-03-26-global-config-and-project-mounting-design.md` §本地会话自动同步

**Depends on:** Plan 2 (项目挂载), Plan 3 (远程会话重构)

---

## File Structure

| Action | Path                                   | Responsibility                                                  |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| Create | `src/session-sync.ts`                  | 轮询发现 + 频道创建 + 会话注册                                  |
| Create | `src/codex-session-discovery.ts`       | Codex 索引读取、会话文件定位、`session_meta` 解析、项目归属过滤 |
| Modify | `src/bot.ts`                           | 启动同步定时器                                                  |
| Modify | `src/session-manager.ts`               | 新增 `createSyncedSession` 方法                                 |
| Create | `test/codex-session-discovery.test.ts` | Codex 发现逻辑测试                                              |
| Create | `test/session-sync.test.ts`            | 同步逻辑测试                                                    |

---

### Task 1: 实现 Codex 会话发现模块

**Files:**

- Create: `src/codex-session-discovery.ts`
- Create: `test/codex-session-discovery.test.ts`

- [ ] **Step 1: 写失败测试**

测试覆盖：

- `readSessionIndex()` 读取 `session_index.jsonl`，提取 `id` / `thread_name` / `updated_at`
- 索引记录缺少 `id` 时跳过
- `findSessionFileById()` 允许通过扫描 `sessions/**/*.jsonl` 内容匹配 `id`
- 会话文件首条不是 `session_meta` 时跳过
- `session_meta.payload.cwd` 缺失时跳过
- `cwd` 不在任何已挂载项目根目录之下时跳过
- 返回结果带上 `id`、`threadName`、`updatedAt`、`cwd`、`projectPath`
- 缺少 `session_index.jsonl` 或 `sessions/` 目录时返回空数组，不抛异常

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- test/codex-session-discovery.test.ts
```

Expected: FAIL — module `../src/codex-session-discovery.ts` not found

- [ ] **Step 3: 实现 `src/codex-session-discovery.ts`**

```typescript
import { readFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export interface CodexIndexedSession {
  id: string;
  threadName: string;
  updatedAt?: number;
}

export interface CodexDiscoveredSession {
  id: string;
  threadName: string;
  updatedAt?: number;
  cwd: string;
  projectPath: string;
}

export function readSessionIndex(codexHome = join(homedir(), '.codex')): CodexIndexedSession[] {
  // 读取 session_index.jsonl，解析 JSONL，过滤缺少 id 的记录
}

export function findSessionFileById(
  id: string,
  codexHome = join(homedir(), '.codex'),
): string | null {
  // 扫描 sessions/**/*.jsonl，允许通过文件内容匹配 id
}

export function isSubpathOfProject(cwd: string, projectPath: string): boolean {
  const normalizedCwd = resolve(cwd);
  const normalizedProject = resolve(projectPath);
  return (
    normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}${sep}`)
  );
}

export function listCodexSessionsForProjects(
  projectPaths: string[],
  codexHome = join(homedir(), '.codex'),
): CodexDiscoveredSession[] {
  // 读取索引 → 按 id 定位文件 → 读取首条 session_meta.payload.cwd → 过滤属于已挂载项目的会话
}
```

实现要求：

- `thread_name` 缺失时可回退为 `id`
- 只读取会话文件首条记录用于判断 `cwd`
- 任一候选会话解析失败时直接跳过，不影响其他会话
- 多个项目都能匹配时，选择路径最长的那个项目，避免嵌套项目误归属

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- test/codex-session-discovery.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/codex-session-discovery.ts test/codex-session-discovery.test.ts
git commit -m "feat: add Codex session discovery from JSONL state"
```

### Task 2: 实现会话同步核心模块

**Files:**

- Create: `src/session-sync.ts`
- Modify: `src/session-manager.ts`

- [ ] **Step 1: 在 `session-manager.ts` 新增 `createSyncedSession`**

```typescript
export async function createSyncedSession(
  id: string,
  channelId: string,
  directory: string,
  projectName: string,
  provider: ProviderName,
  providerSessionId: string,
): Promise<Session>;
```

与 `createSession` 类似，但：

- 不做 name 去重（ID 来自 provider）
- 不创建 tmux（已移除）
- 标记 `source: 'local-sync'`

- [ ] **Step 2: 实现 `src/session-sync.ts`**

```typescript
import type { Client, Guild, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { listCodexSessionsForProjects } from './codex-session-discovery.ts';
import { getAllRegisteredProjects, updateProjectDiscord } from './project-registry.ts';
import * as sessions from './session-manager.ts';

const SYNC_INTERVAL_MS = 30_000;
let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startSync(client: Client): void {
  void runSync(client);
  syncTimer = setInterval(() => void runSync(client), SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  if (syncTimer) clearInterval(syncTimer);
}

async function runSync(client: Client): Promise<void> {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const projects = getAllRegisteredProjects();
  if (projects.length === 0) return;

  const existingSessions = sessions.getAllSessions();
  const existingProviderIds = new Set(
    existingSessions.map((s) => s.providerSessionId).filter(Boolean),
  );

  for (const project of projects) {
    try {
      const claudeSessions = await listSessions({ dir: project.path, limit: 50 });
      for (const cs of claudeSessions) {
        if (existingProviderIds.has(cs.sessionId)) continue;
        await syncSession(
          guild,
          project,
          'claude',
          cs.sessionId,
          cs.summary || cs.firstPrompt || cs.sessionId,
        );
        existingProviderIds.add(cs.sessionId);
      }
    } catch {
      // skip this project
    }
  }

  const codexSessions = listCodexSessionsForProjects(projects.map((p) => p.path));
  for (const session of codexSessions) {
    if (existingProviderIds.has(session.id)) continue;
    const project = projects.find((p) => p.path === session.projectPath);
    if (!project) continue;
    await syncSession(guild, project, 'codex', session.id, session.threadName);
    existingProviderIds.add(session.id);
  }
}
```

同步要求：

- Codex 仅使用发现模块返回的 `projectPath` 和 `cwd` 结果，不在 `session-sync.ts` 内重复猜测项目归属
- 找不到项目、创建频道失败、或单条会话注册失败时记录日志并继续下一条
- 已存在 `providerSessionId` 的会话不得重复创建

- [ ] **Step 3: Commit**

```bash
git add src/session-sync.ts src/session-manager.ts
git commit -m "feat: implement local session sync for Claude and Codex JSONL discovery"
```

### Task 3: 集成到 `bot.ts`

**Files:**

- Modify: `src/bot.ts`

- [ ] **Step 1: 在 ready 事件中启动同步**

```typescript
import { startSync, stopSync } from './session-sync.ts';

// 在 ready handler 中，loadSessions() 之后：
startSync(client);

// 在 shutdown handler 中：
stopSync();
```

- [ ] **Step 2: 手动测试**

1. 在某个已挂载项目目录下用 `claude` 或 `codex` 创建一个会话
2. 启动 bot
3. 等待 30s
4. 检查 Discord 是否出现新频道
5. 在频道中发消息，确认 resume 正常

- [ ] **Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat: start session sync on bot ready"
```

### Task 4: 测试同步逻辑

**Files:**

- Create: `test/session-sync.test.ts`

- [ ] **Step 1: 写测试**

测试覆盖：

- 发现新 Claude 会话 → 创建频道 + 注册
- 发现新 Codex 会话 → 创建频道 + 注册
- 已注册会话不重复创建
- 项目无 Category 时懒创建
- Claude SDK 不可用时不崩溃
- Codex 缺少 `session_index.jsonl` 时不崩溃
- Codex 会话文件首条不是 `session_meta` 时不崩溃且不创建频道
- Codex 会话 `cwd` 不属于已挂载项目时不创建频道

使用 mock：

- `vi.mock('@anthropic-ai/claude-agent-sdk')` mock `listSessions`
- `vi.mock('./codex-session-discovery.ts')` mock `listCodexSessionsForProjects`
- `vi.mock('./session-manager.ts')` mock session 操作
- `vi.mock('./project-registry.ts')` mock 项目注册表

- [ ] **Step 2: 运行测试**

```bash
pnpm test -- test/session-sync.test.ts
```

- [ ] **Step 3: 运行完整测试**

```bash
pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add test/session-sync.test.ts
git commit -m "test: add session sync tests for JSONL-backed discovery"
```
