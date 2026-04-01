# Plan 3/4: 远程会话重构 — /session new 必须选择已挂载项目

> **大前提：** workspacecord 的目标形态是全局安装的命令行工具（`npm install -g workspacecord`），以后台常驻服务运行。本计划将 Discord 端的会话创建从"指定任意目录"改为"选择已挂载项目"，确保所有远程会话都归属于用户显式注册的项目。

> **状态更新（2026-03-31）：方案已演化。**
>
> 这份计划描述的是一版中间态：在保留 `/session new` / `/session resume` 语义的前提下，把目录选择改成项目选择。
>
> 当前实际落地方案进一步前移了控制面：
>
> - 命令名已从 `workspacecord` 演化为 `workspacecord`
> - Discord 侧先用 `/project setup` 把当前分类绑定到已挂载项目
> - 后续远程创建主代理会话改为 `/agent spawn`
> - “所有远程会话都必须归属于已挂载项目”这一核心约束仍然保留，但它不再通过旧 `/session new` 交互表面体现
>
> 因此，本文件应视为“约束来源的历史计划”，不是当前命令设计的逐字实现说明。

**Goal:** 重构 Discord `/session new` 命令，从"指定目录自动推导项目"改为"必须选择已挂载项目"

**Architecture:** `/session new` 的 `directory` 参数替换为 `project` 参数（autocomplete 从注册表读取），会话创建时从项目注册表获取目录和 Category，移除 `projectNameFromDir` 和 `ensureProjectCategory` 中的自动创建逻辑。这样远程新建会话与本地同步会话都共享同一套“已挂载项目边界”语义。

**Spec:** `docs/superpowers/specs/2026-03-26-global-config-and-project-mounting-design.md` §远程会话模型

**Depends on:** Plan 2 (项目挂载)

---

## File Structure

| Action | Path                                 | Responsibility                             |
| ------ | ------------------------------------ | ------------------------------------------ |
| Modify | `src/commands.ts`                    | /session new 和 /session resume 的参数定义 |
| Modify | `src/command-handlers.ts`            | 会话创建逻辑重构                           |
| Modify | `test/command-handlers-sync.test.ts` | 更新测试                                   |

---

### Task 1: 修改 /session new 命令参数

**Files:**

- Modify: `src/commands.ts`

- [ ] **Step 1: 替换 directory 参数为 project 参数**

`/session new` 子命令：

- 移除 `directory` option
- 新增 `project` option（string, required, autocomplete enabled）

`/session resume` 子命令：

- 移除 `directory` option
- 新增 `project` option（string, required, autocomplete enabled）

- [ ] **Step 2: Commit**

```bash
git add src/commands.ts
git commit -m "feat: replace directory option with project option in /session commands"
```

### Task 2: 实现 project autocomplete

**Files:**

- Modify: `src/command-handlers.ts`
- Modify: `src/bot.ts`（路由 autocomplete 事件到 handleProjectAutocomplete）

```typescript
// 在 command-handlers.ts 顶部新增 import
import { getAllRegisteredProjects } from './project-registry.ts';

export async function handleProjectAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const focused = interaction.options.getFocused();
  const projects = getAllRegisteredProjects();
  const filtered = projects
    .filter((p) => p.name.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((p) => ({ name: `${p.name} (${p.path})`, value: p.name }));
  await interaction.respond(filtered);
}
```

- [ ] **Step 2: 在 bot.ts 中注册 autocomplete handler**

在 `interactionCreate` 的 `isAutocomplete()` 分支中，对 `/session` 命令也调用 `handleProjectAutocomplete`。

- [ ] **Step 3: Commit**

```bash
git add src/command-handlers.ts src/bot.ts
git commit -m "feat: add project autocomplete for /session commands"
```

### Task 3: 重构 handleSessionNew

**Files:**

- Modify: `src/command-handlers.ts`

- [ ] **Step 1: 重写 handleSessionNew 的项目解析逻辑**

核心变更：

- 从 `interaction.options.getString('project')` 获取项目名
- 从 `project-registry.ts` 的 `getProjectByName(projectName)` 获取项目
- 如果项目不存在，回复错误："No project found. Register one with `workspacecord project init`."
- 如果项目没有 `discordCategoryId`，懒创建 Category 并更新注册表
- `directory` 从项目注册表获取（`project.path`）
- 移除 `projectNameFromDir` 调用
- 移除 `config.defaultDirectory` fallback

- [ ] **Step 2: 同样重构 handleSessionResume**

同 handleSessionNew 的逻辑。

- [ ] **Step 3: 简化 ensureProjectCategory**

不再接受 `directory` 参数自动创建项目，改为只接受 `RegisteredProject` 并确保 Discord Category 存在。

- [ ] **Step 4: 更新测试**

```bash
pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add src/command-handlers.ts test/command-handlers-sync.test.ts
git commit -m "refactor: /session new requires mounted project, remove auto-derive"
```

### Task 4: 清理遗留代码

**Files:**

- Modify: `src/command-handlers.ts`
- Modify: `src/utils.ts`

- [ ] **Step 1: 移除不再使用的函数**

- `projectNameFromDir` — 不再需要
- `parseTopicDirectory` — 保留，session-sync 和频道恢复仍需要
- `ensureProjectCategory` 中的自动创建项目逻辑

- [ ] **Step 2: 运行测试和类型检查**

```bash
pnpm test && pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/command-handlers.ts src/utils.ts
git commit -m "chore: remove projectNameFromDir and auto-derive logic"
```
