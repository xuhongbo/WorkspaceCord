# Agent Cleanup Command Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前项目分类新增 `/agent cleanup`，预览并确认后批量归档其他空闲主会话，同时保留当前频道、`control`、`#history` 并跳过进行中的会话。

**Architecture:** 在命令层新增 `/agent cleanup` 入口，复用 `resolveProjectCategoryId(...)` 解析上下文；在 `session-housekeeping` 中新增“预览构建 + 批量归档执行”纯逻辑；在按钮层新增确认/取消交互，并用内存请求仓库与项目级互斥锁保护批量执行。

**Tech Stack:** TypeScript、discord.js、Vitest、既有 `archiveSession(...)` / `thread-manager` / `project-manager` 模块。

---

## Chunk 1: 命令入口、预览构建与请求缓存

### Task 1: 为 `/agent cleanup` 建立命令面与预览数据模型

**Files:**
- Create: `src/agent-cleanup-request-store.ts`
- Modify: `src/commands.ts`
- Modify: `src/command-handlers.ts`
- Modify: `src/session-housekeeping.ts`
- Test: `test/session-housekeeping.test.ts`
- Test: `test/command-handlers-matrix.test.ts`

- [ ] **Step 1: 先写 `session-housekeeping` 的失败测试，锁定筛选规则**

在 `test/session-housekeeping.test.ts` 新增用例，覆盖：

```ts
it('buildProjectCleanupPreview 仅返回当前项目下可归档的空闲主会话', async () => {
  getAllSessions.mockReturnValue([
    { id: 'keep-current', channelId: 'current', categoryId: 'cat-1', type: 'persistent', isGenerating: false, agentLabel: 'current' },
    { id: 'keep-control', channelId: 'control-1', categoryId: 'cat-1', type: 'persistent', isGenerating: false, agentLabel: 'control' },
    { id: 'skip-running', channelId: 'run-1', categoryId: 'cat-1', type: 'persistent', isGenerating: true, agentLabel: 'running' },
    { id: 'archive-idle', channelId: 'idle-1', categoryId: 'cat-1', type: 'persistent', isGenerating: false, agentLabel: 'idle' },
    { id: 'other-category', channelId: 'idle-2', categoryId: 'cat-2', type: 'persistent', isGenerating: false, agentLabel: 'other' },
    { id: 'subagent', channelId: 'thread-1', categoryId: 'cat-1', type: 'subagent', isGenerating: false, agentLabel: 'sub' },
  ]);

  const preview = buildProjectCleanupPreview({
    categoryId: 'cat-1',
    currentChannelId: 'current',
    controlChannelId: 'control-1',
    historyChannelId: 'history-1',
    projectName: 'demo',
  });

  expect(preview.archiveCandidates.map((s) => s.id)).toEqual(['archive-idle']);
  expect(preview.skippedGenerating.map((s) => s.id)).toEqual(['skip-running']);
});
```

- [ ] **Step 2: 运行该测试，确认先红灯**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/session-housekeeping.test.ts
```

Expected: 失败，报 `buildProjectCleanupPreview` 未实现或断言不成立。

- [ ] **Step 3: 在 `src/session-housekeeping.ts` 实现预览构建类型与函数**

新增精确类型与函数：

```ts
export interface ProjectCleanupPreview {
  categoryId: string;
  projectName: string;
  protectedChannels: {
    currentChannelId: string;
    controlChannelId?: string;
    historyChannelId?: string;
  };
  archiveCandidates: ThreadSession[];
  skippedGenerating: ThreadSession[];
  skippedUnknown: ThreadSession[];
}

export function buildProjectCleanupPreview(input: {
  categoryId: string;
  currentChannelId: string;
  controlChannelId?: string;
  historyChannelId?: string;
  projectName: string;
}): ProjectCleanupPreview {
  // 基于 getSessionsByCategory / getAllSessions 的稳定筛选
}
```

实现要求：
- 仅保留当前分类的 `persistent` 会话
- 跳过当前频道、`control`、`#history`
- `isGenerating === true` 进入 `skippedGenerating`
- 其他无法处理对象进入 `skippedUnknown`
- 结果顺序稳定，优先按 `lastActivity` 升序，再按 `agentLabel`

- [ ] **Step 4: 重新运行测试，确认变绿**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/session-housekeeping.test.ts
```

Expected: 新增筛选用例通过。

- [ ] **Step 5: 先写命令预览阶段的失败测试**

在 `test/command-handlers-matrix.test.ts` 新增用例，覆盖：
- `/agent cleanup` 会回复预览消息
- 无候选时直接提示“没有可清理的空闲会话”
- 预览消息带两枚按钮

示例断言：

```ts
expect(interaction.reply).toHaveBeenCalledWith(
  expect.objectContaining({
    ephemeral: true,
    components: expect.any(Array),
  }),
);
```

- [ ] **Step 6: 运行命令处理测试，确认先红灯**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/command-handlers-matrix.test.ts
```

Expected: 失败，报 `cleanup` 子命令未定义或处理分支缺失。

- [ ] **Step 7: 最小实现命令入口与请求存储**

在 `src/commands.ts` 增加：

```ts
.addSubcommand((sub) =>
  sub.setName('cleanup').setDescription('预览并批量归档当前项目下的其他空闲会话'),
)
```

在 `src/agent-cleanup-request-store.ts` 实现：

```ts
export interface AgentCleanupRequest {
  id: string;
  userId: string;
  guildId: string;
  categoryId: string;
  currentChannelId: string;
  candidateSessionIds: string[];
  createdAt: number;
}

export function createCleanupRequest(...): AgentCleanupRequest
export function getCleanupRequest(id: string): AgentCleanupRequest | undefined
export function deleteCleanupRequest(id: string): boolean
export function cleanupExpiredRequests(now?: number): number
```

在 `src/command-handlers.ts`：
- `handleAgent(...)` 中新增 `cleanup` 分支
- 实现 `handleAgentCleanup(interaction)`
- 复用 `resolveProjectCategoryId(...)`
- 调用 `buildProjectCleanupPreview(...)`
- 生成预览文案与按钮：`cleanup:confirm:<id>` / `cleanup:cancel:<id>`
- 候选为空时直接 `reply({ content: '没有可清理的空闲会话', ephemeral: true })`

- [ ] **Step 8: 运行命令处理测试，确认预览阶段变绿**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/command-handlers-matrix.test.ts test/session-housekeeping.test.ts
```

Expected: 与 `/agent cleanup` 相关的新用例通过。

## Chunk 2: 确认/取消按钮与批量归档执行

### Task 2: 实现确认、取消、互斥锁与批量归档汇总

**Files:**
- Modify: `src/session-housekeeping.ts`
- Modify: `src/button-handler.ts`
- Modify: `src/agent-cleanup-request-store.ts`
- Test: `test/button-handler.test.ts`
- Test: `test/session-housekeeping.test.ts`

- [ ] **Step 1: 先写批量归档执行的失败测试**

在 `test/session-housekeeping.test.ts` 新增：
- 会对空闲候选调用 `archiveSession(...)`
- 已变成 `isGenerating` 的会话在执行时跳过
- 单条失败不阻断后续，并记录 `failed`

目标接口：

```ts
const result = await archiveSessionsById(guild as never, ['s1', 's2'], 'bulk cleanup');
expect(result.archivedSessions).toBe(1);
expect(result.skippedGenerating).toBe(1);
expect(result.failed).toEqual([]);
```

- [ ] **Step 2: 运行 `session-housekeeping` 测试，确认先红灯**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/session-housekeeping.test.ts
```

Expected: 失败，报 `archiveSessionsById` 未实现。

- [ ] **Step 3: 最小实现批量归档与项目级锁**

在 `src/session-housekeeping.ts` 新增：

```ts
export interface SessionArchiveByIdResult {
  archivedSessions: number;
  skippedGenerating: number;
  missingSessions: number;
  failed: Array<{ sessionId: string; channelId?: string; message: string }>;
}

export async function archiveSessionsById(
  guild: Guild,
  sessionIds: Iterable<string>,
  summary = 'Bulk cleanup from Discord command',
): Promise<SessionArchiveByIdResult>
```

实现要求：
- 通过 `getSession(...)` 重新读取当前状态
- `session.type !== 'persistent'` 或会话不存在时记为缺失/跳过
- `session.isGenerating` 记入 `skippedGenerating`
- 否则调用 `archiveSession(session, guild, summary)`
- 累计汇总，不因单条失败中断

在 `src/agent-cleanup-request-store.ts` 增加轻量锁：

```ts
export function acquireCleanupLock(categoryId: string): boolean
export function releaseCleanupLock(categoryId: string): void
```

- [ ] **Step 4: 重新运行 `session-housekeeping` 测试，确认变绿**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/session-housekeeping.test.ts
```

Expected: 新增批量归档用例通过。

- [ ] **Step 5: 先写按钮交互失败测试**

在 `test/button-handler.test.ts` 新增用例，覆盖：
- 只有发起人可以确认或取消
- 取消会删除请求并更新消息
- 确认会调用 `archiveSessionsById(...)`
- 请求过期时提示重新执行
- 互斥锁冲突时拒绝重复执行

示例断言：

```ts
expect(interaction.update).toHaveBeenCalledWith(
  expect.objectContaining({ components: [] }),
);
```

- [ ] **Step 6: 运行按钮测试，确认先红灯**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/button-handler.test.ts
```

Expected: 失败，报未知按钮或依赖未接线。

- [ ] **Step 7: 在 `src/button-handler.ts` 实现 cleanup 按钮分支**

新增逻辑：

```ts
if (customId.startsWith('cleanup:cancel:')) { ... }
if (customId.startsWith('cleanup:confirm:')) { ... }
```

确认分支要求：
- 校验发起人
- 校验请求存在且未过期
- 抢占分类锁，失败则提示“当前项目正在执行批量清理”
- 调用 `archiveSessionsById(...)`
- `finally` 中释放锁
- 将原消息更新为结果态并移除按钮

取消分支要求：
- 校验发起人
- 删除请求
- 更新原消息为“本次批量清理已取消。”
- 移除按钮

- [ ] **Step 8: 运行按钮与相关回归测试，确认变绿**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/button-handler.test.ts test/session-housekeeping.test.ts test/command-handlers-matrix.test.ts
```

Expected: 新增按钮交互与批量执行测试通过。

## Chunk 3: 收口、文案、回归验证

### Task 3: 收紧文案与回归现有命令契约

**Files:**
- Modify: `src/command-handlers.ts`
- Modify: `src/button-handler.ts`
- Test: `test/commands-contract.test.ts`
- Test: `test/command-handlers.test.ts`

- [ ] **Step 1: 先写或补充契约测试**

确保 `/agent cleanup` 出现在命令定义中，并验证预览/结果文案包含：
- 保留项
- 跳过中的会话数
- 已归档数 / 失败数

- [ ] **Step 2: 运行命令契约测试，确认先红灯**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run test/commands-contract.test.ts test/command-handlers.test.ts
```

Expected: 失败，因新增子命令尚未完整进入契约或断言未满足。

- [ ] **Step 3: 最小修正文案与测试夹具**

只做必要收口：
- 预览文案稳定
- 结果汇总字段稳定
- 现有命令测试夹具兼容 `cleanup`
- 不扩展额外参数或高级筛选

- [ ] **Step 4: 运行功能相关完整测试集**

Run:

```bash
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run \
  test/session-housekeeping.test.ts \
  test/button-handler.test.ts \
  test/command-handlers.test.ts \
  test/command-handlers-matrix.test.ts \
  test/commands-contract.test.ts
```

Expected: 上述功能相关测试全部通过。

- [ ] **Step 5: 运行类型检查与最终回归验证**

Run:

```bash
npm run typecheck
HOME=/tmp/workspacecord-home XDG_CONFIG_HOME=/tmp/workspacecord-xdg npx vitest run \
  test/session-housekeeping.test.ts \
  test/button-handler.test.ts \
  test/command-handlers.test.ts \
  test/command-handlers-matrix.test.ts \
  test/commands-contract.test.ts
```

Expected:
- `typecheck` 通过
- 功能相关测试通过
- 若全量 `npm test` 仍受当前沙箱的 `listen EPERM` 限制，则在交付说明中明确记录这是环境限制，不把它误报成新回归
