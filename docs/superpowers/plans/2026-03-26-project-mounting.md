# Plan 2/4: 项目挂载 — project init/list/info/rename/remove

> **大前提：** workspacecord 的目标形态是全局安装的命令行工具（`npm install -g workspacecord`），以后台常驻服务运行。本计划实现显式项目挂载机制 — 用户在任意项目目录下执行 `workspacecord project init` 将其注册为受管项目。

> **状态更新（2026-03-31）：方案已演化。**
>
> 这份计划保留为历史设计记录，不再等同于当前产品表面。
>
> 当前落地方案与本计划的主要差异：
>
> - 命令名已从 `workspacecord` 演化为 `workspacecord`
> - Discord 侧的主控制面不再围绕旧“会话命令族”展开，而是以 `/project setup` 绑定项目、以 `/agent spawn` 创建主代理会话为主
> - 本计划中的 Discord `/project list` 没有继续落地；当前以 Discord 分类结构表达项目归属，以本地 `workspacecord project list` 查看完整挂载信息
> - 因此，阅读本文件时应把它理解为“项目挂载边界的来源说明”，而不是“当前命令面逐项实现清单”

**Goal:** 实现显式项目挂载机制，用户在本地目录执行 `workspacecord project init` 注册项目，Discord Category 懒创建

**Architecture:** 新增 project-registry.ts 管理全局项目注册表（使用 Plan 1 迁移后的 Store 类，存储在 ~/.workspacecord/projects.json），新增 project-cli.ts 处理 CLI 命令，修改 project-manager.ts 从注册表读取而非自动推导。project init 只做本地注册，Discord Category 在 bot 启动或首次创建会话时懒创建。该注册表同时是本地会话同步的项目边界来源：Codex 仅同步 `session_meta.payload.cwd` 位于已挂载项目根目录之下的会话。

**Tech Stack:** @clack/prompts (已有), vitest (已有)

**Spec:** `docs/superpowers/specs/2026-03-26-global-config-and-project-mounting-design.md` §项目挂载设计

**Depends on:** Plan 1 (全局配置)

---

## File Structure

| Action | Path                            | Responsibility                                    |
| ------ | ------------------------------- | ------------------------------------------------- |
| Create | `src/project-registry.ts`       | 全局项目注册表 CRUD（~/.workspacecord/projects.json） |
| Create | `src/project-cli.ts`            | CLI project 子命令处理                            |
| Modify | `src/cli.ts`                    | 新增 project 子命令路由                           |
| Modify | `src/project-manager.ts`        | 从 project-registry 读取，移除自动推导            |
| Modify | `src/command-handlers.ts`       | ensureProjectCategory 改为从注册表读取            |
| Create | `test/project-registry.test.ts` | 项目注册表测试                                    |

---

### Task 1: 创建项目注册表模块

**Files:**

- Create: `src/project-registry.ts`
- Create: `test/project-registry.test.ts`

- [ ] **Step 1: 写测试**

测试覆盖：

- 注册项目（name + path）
- 按 name 查询
- 按 path 查询
- 列出所有项目
- 重命名项目
- 删除项目
- 重复路径拒绝
- 重复名称拒绝
- 幂等注册（同 path 同 name 不报错）

- [ ] **Step 2: 实现 `src/project-registry.ts`**

```typescript
import { Store } from './persistence.ts';

export interface RegisteredProject {
  id: string; // uuid
  name: string;
  path: string;
  discordCategoryId?: string;
  discordLogChannelId?: string;
  personality?: string;
  skills: Record<string, string>;
  mcpServers: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
  createdAt: number;
}

const store = new Store<RegisteredProject[]>('projects.json');
let projects: RegisteredProject[] = [];

export async function loadRegistry(): Promise<void>;
export function getProjectByName(name: string): RegisteredProject | undefined;
export function getProjectByPath(path: string): RegisteredProject | undefined;
export function getAllRegisteredProjects(): RegisteredProject[];
export async function registerProject(name: string, path: string): Promise<RegisteredProject>;
export async function renameProject(oldName: string, newName: string): Promise<void>;
export async function removeProject(name: string): Promise<void>;
export async function updateProjectDiscord(
  name: string,
  categoryId: string,
  logChannelId?: string,
): Promise<void>;
```

- [ ] **Step 3: 运行测试确认通过**

- [ ] **Step 4: Commit**

```bash
git add src/project-registry.ts test/project-registry.test.ts
git commit -m "feat: add project registry module"
```

### Task 2: 实现 project CLI 命令

**Files:**

- Create: `src/project-cli.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: 实现 `src/project-cli.ts`**

导出 `handleProject(args: string[])`，处理子命令：

- `init [--name <name>]` — 在 cwd 注册项目，name 默认取 basename(cwd)
- `list` — 列出所有已注册项目
- `info` — 显示当前目录对应的项目信息
- `rename <new-name>` — 重命名当前目录的项目
- `remove` — 移除当前目录的项目注册

`init` 时检查 bot 是否在线（尝试连接 Discord），不在线时提示用户：
"Project registered locally. Discord category will be created when the bot starts."

- [ ] **Step 2: 在 cli.ts 中新增 project 路由**

```typescript
case 'project': {
  const { handleProject } = await import('./project-cli.ts');
  await handleProject(process.argv.slice(3));
  break;
}
```

- [ ] **Step 3: 手动测试**

```bash
cd /tmp/test-project
workspacecord project init --name my-test
workspacecord project list
workspacecord project rename my-test-renamed
workspacecord project info
workspacecord project remove
```

- [ ] **Step 4: Commit**

```bash
git add src/project-cli.ts src/cli.ts
git commit -m "feat: implement project CLI commands (init/list/info/rename/remove)"
```

### Task 3: 重构 project-manager.ts 对接注册表

**Files:**

- Modify: `src/project-manager.ts`
- Modify: `src/bot.ts`

- [ ] **Step 1: 重构 project-manager.ts**

- 移除内部的 `projectStore` 和 `projects` 对象
- 所有读操作代理到 `project-registry.ts`
- `getOrCreateProject` 改为只读查询（不再自动创建）
- `getProject` / `getAllProjects` / `getPersonality` 等从注册表读取
- personality / skills / mcpServers 的写操作更新注册表

- [ ] **Step 2: 更新 bot.ts**

在 ready 事件中：

- `await loadRegistry()` 替代 `await loadProjects()`
- 遍历已注册项目，对有 `discordCategoryId` 的项目验证 Category 是否存在
- 对没有 `discordCategoryId` 的项目（本地注册但 bot 未在线时），懒创建 Category

- [ ] **Step 3: 运行测试**

```bash
pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add src/project-manager.ts src/bot.ts
git commit -m "refactor: project-manager reads from global registry, lazy-create categories"
```

### Task 4: 新增 Discord /project list 命令

> **演化说明：** 这一任务已被放弃。当前产品没有补做 Discord `/project list`，因为 Discord 分类本身已经天然表达项目结构；如需完整挂载信息，使用本地 `workspacecord project list`。

**Files:**

- Modify: `src/commands.ts`
- Modify: `src/command-handlers.ts`

- [ ] **Step 1: 在 commands.ts 中注册 /project list**

新增 `project` slash command，包含 `list` 子命令。

- [ ] **Step 2: 在 command-handlers.ts 中实现 handleProjectList**

列出所有已注册项目，显示 name、path、Discord category 状态。

- [ ] **Step 3: 在 bot.ts 中路由 /project 命令**

- [ ] **Step 4: Commit**

```bash
git add src/commands.ts src/command-handlers.ts src/bot.ts
git commit -m "feat: add /project list Discord command"
```
