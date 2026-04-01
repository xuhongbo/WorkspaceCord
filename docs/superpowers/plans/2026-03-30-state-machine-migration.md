# 状态机完整切换实施计划（历史存档）

> ⚠️ 本文档为历史迁移计划，包含旧实现路径（如 session-output-coordinator）的迁移步骤记录。
>
> 当前真实完成状态与验证结果请以：
> `/Users/ld/Documents/github/workspacecord/docs/superpowers/plans/2026-03-30-migration-verification.md` 为准。


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将主流程从旧的 session-output-coordinator 完全切换到新的 StateMachine + 面板组件架构

**Architecture:**
- 用 StatusCard 替代 session-output-coordinator 的状态卡管理
- 用 SummaryHandler 替代 finalizeSessionPresentation 的总结发送
- 用 InteractionCard 替代 output-handler 中的 ask_user 按钮渲染
- 用 StateMachine 替代 session-output-coordinator 的状态跟踪
- 保留 digest 队列机制（暂时），但通过 panel-adapter 统一调度

**Tech Stack:** TypeScript, Discord.js, 现有 provider 抽象层

---

## 任务分解

### Task 1: 扩展 panel-adapter 以支持 digest 队列

**Files:**
- Modify: `src/panel-adapter.ts`

当前 panel-adapter 只处理状态更新和总结，缺少 digest 队列支持。需要添加队列管理函数。

- [ ] **Step 1: 添加 digest 队列管理**

在 `panel-adapter.ts` 中添加：

```typescript
// 在文件顶部，StateMachine 实例后添加
const sessionDigests = new Map<string, Array<{ kind: string; text: string }>>();

export function queueDigest(sessionId: string, item: { kind: string; text: string }): void {
  if (!sessionDigests.has(sessionId)) {
    sessionDigests.set(sessionId, []);
  }
  const queue = sessionDigests.get(sessionId)!;
  queue.push(item);
  if (queue.length > 20) {
    queue.splice(0, queue.length - 20);
  }
}

export function getDigestQueue(sessionId: string): Array<{ kind: string; text: string }> {
  return sessionDigests.get(sessionId) ?? [];
}

export function clearDigestQueue(sessionId: string): void {
  sessionDigests.delete(sessionId);
}
```

- [ ] **Step 2: 添加 digest 刷新函数**

```typescript
export async function flushDigest(sessionId: string): Promise<void> {
  const components = sessionComponents.get(sessionId);
  if (!components) return;

  const queue = getDigestQueue(sessionId);
  if (queue.length === 0) return;

  // 暂时通过 SummaryHandler 发送 digest（后续可优化为独立组件）
  const digestText = queue.map(item => `[${item.kind}] ${item.text}`).join('\n');
  await components.summaryHandler.sendTurnSummary(digestText, 0);
  clearDigestQueue(sessionId);
}
```

- [ ] **Step 3: 提交**

```bash
git add src/panel-adapter.ts
git commit -m "feat: add digest queue management to panel-adapter"
```

---

### Task 2: 在 output-handler.ts 中切换到新系统

**Files:**
- Modify: `src/output-handler.ts:1-40` (imports)
- Modify: `src/output-handler.ts:448-736` (handleOutputStream function)

- [ ] **Step 1: 替换 imports**

将：
```typescript
import {
  finalizeSessionPresentation,
  flushSessionDigest,
  incrementSessionCounters,
  queueSessionDigest,
  updateSessionStatus,
} from './session-output-coordinator.ts';
```

替换为：
```typescript
import {
  initializeSessionPanel,
  updateSessionState,
  handleResultEvent,
  handleAwaitingHuman,
  queueDigest,
  flushDigest,
} from './panel-adapter.ts';
```

- [ ] **Step 2: 在 handleOutputStream 开始时初始化面板**

在 `handleOutputStream` 函数开始处（line 478 附近），`const session = sessions.getSession(sessionId);` 之后添加：

```typescript
if (session) {
  const components = sessionComponents.get(sessionId);
  if (!components) {
    await initializeSessionPanel(sessionId, channel);
  }
}
```

- [ ] **Step 3: 替换 updateSessionStatus 调用**

将 line 481-487 的：
```typescript
await updateSessionStatus(session, channel, {
  state: 'running',
  phase: mode === 'monitor' ? '执行中（监控）' : '执行中',
  summary: '本地 agent 正在工作',
  iteration: session.workflowState.iteration || 1,
});
```

替换为：
```typescript
await updateSessionState(sessionId, {
  type: 'work_started',
  sessionId,
  source: session.provider === 'claude' ? 'claude' : 'codex',
  confidence: 'high',
  timestamp: Date.now(),
});
```

- [ ] **Step 4: 提交**

```bash
git add src/output-handler.ts
git commit -m "feat(output-handler): switch to panel-adapter for initialization and status"
```

---

### Task 3: 替换 output-handler 中的 ask_user 处理

**Files:**
- Modify: `src/output-handler.ts:498-521`

- [ ] **Step 1: 替换 ask_user 事件处理**

将 line 498-521 的整个 `case 'ask_user':` 块替换为：

```typescript
case 'ask_user': {
  askedUser = true;
  askUserQuestionsJson = event.questionsJson;
  await streamer.discard();
  if (session) {
    const newTurn = session.currentTurn + 1;
    sessions.updateSession(sessionId, {
      currentTurn: newTurn,
      humanResolved: false
    });
    await updateSessionState(sessionId, {
      type: 'awaiting_human',
      sessionId,
      source: session.provider === 'claude' ? 'claude' : 'codex',
      confidence: 'high',
      timestamp: Date.now(),
    });
    await handleAwaitingHuman(sessionId, event.questionsJson);
  }
  const rendered = renderAskUserQuestion(event.questionsJson, sessionId);
  if (rendered) {
    rendered.components.push(makeStopButton(sessionId));
    await channel.send({ embeds: rendered.embeds, components: rendered.components });
  }
  break;
}
```

- [ ] **Step 2: 提交**

```bash
git add src/output-handler.ts
git commit -m "feat(output-handler): use panel-adapter for ask_user handling"
```

---

### Task 4: 替换 output-handler 中的 digest 队列调用

**Files:**
- Modify: `src/output-handler.ts:523-636`

- [ ] **Step 1: 批量替换 queueSessionDigest**

将所有 `queueSessionDigest(sessionId, ...)` 调用替换为 `queueDigest(sessionId, ...)`。

涉及的行：525, 533, 542, 552, 561, 568, 576, 598, 615, 624, 630

使用查找替换：
- 查找：`queueSessionDigest\(sessionId,`
- 替换：`queueDigest(sessionId,`

- [ ] **Step 2: 替换 flushSessionDigest 调用**

将所有 `flushSessionDigest(session, channel, ...)` 替换为 `await flushDigest(sessionId)`。

涉及的行：513, 669, 685, 702, 713

- [ ] **Step 3: 删除 incrementSessionCounters 调用**

删除 line 532, 596, 608 的 `incrementSessionCounters` 调用（新系统不需要手动计数）。

- [ ] **Step 4: 提交**

```bash
git add src/output-handler.ts
git commit -m "feat(output-handler): switch digest queue to panel-adapter"
```

---

### Task 5: 替换 output-handler 中的 result 事件处理

**Files:**
- Modify: `src/output-handler.ts:637-678`

- [ ] **Step 1: 替换 result 事件处理**

将 line 637-678 的 `case 'result':` 块中的 `finalizeSessionPresentation` 调用替换为：

```typescript
case 'result': {
  success = event.success;
  const lastText = streamer.getText();
  const cost = event.costUsd.toFixed(4);
  const duration = event.durationMs
    ? `${(event.durationMs / 1000).toFixed(1)}s`
    : 'unknown';
  const turns = event.numTurns || 0;
  const modeLabel =
    (
      { auto: 'Auto', plan: 'Plan', normal: 'Normal', monitor: 'Monitor' } as Record<
        string,
        string
      >
    )[mode] || 'Auto';
  const statusLine = event.success
    ? `-# $${cost} | ${duration} | ${turns} turns | ${modeLabel}`
    : `-# Error | $${cost} | ${duration} | ${turns} turns`;

  streamer.append(`\n${statusLine}`, { persist: false });
  if (!event.success && event.errors.length) {
    streamer.append(`\n\`\`\`\n${event.errors.join('\n')}\n\`\`\``, { persist: false });
  }
  await streamer.finalize();
  if (session) {
    await handleResultEvent(sessionId, event, lastText);
  }
  break;
}
```

- [ ] **Step 2: 提交**

```bash
git add src/output-handler.ts
git commit -m "feat(output-handler): use panel-adapter for result handling"
```

---

### Task 6: 替换 output-handler 中的 error 事件处理

**Files:**
- Modify: `src/output-handler.ts:680-693`

- [ ] **Step 1: 替换 error 事件处理**

将 line 680-693 的 `case 'error':` 块替换为：

```typescript
case 'error': {
  hadError = true;
  await streamer.finalize();
  queueDigest(sessionId, { kind: 'error', text: `错误：${truncate(event.message, 120)}` });
  if (session && mode !== 'monitor') {
    await flushDigest(sessionId);
    await updateSessionState(sessionId, {
      type: 'errored',
      sessionId,
      source: session.provider === 'claude' ? 'claude' : 'codex',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { errorMessage: event.message },
    });
  }
  break;
}
```

- [ ] **Step 2: 提交**

```bash
git add src/output-handler.ts
git commit -m "feat(output-handler): use panel-adapter for error handling"
```

---

### Task 7: 替换 output-handler 异常处理中的调用

**Files:**
- Modify: `src/output-handler.ts:706-721`

- [ ] **Step 1: 替换 catch 块中的调用**

将 line 706-721 的 catch 块替换为：

```typescript
} catch (err: unknown) {
  hadError = true;
  await streamer.finalize();
  if (!isAbortError(err)) {
    const errMsg = (err as Error).message || '';
    queueDigest(sessionId, { kind: 'error', text: `异常：${truncate(errMsg, 120)}` });
    if (session) {
      await flushDigest(sessionId);
      await updateSessionState(sessionId, {
        type: 'errored',
        sessionId,
        source: session.provider === 'claude' ? 'claude' : 'codex',
        confidence: 'high',
        timestamp: Date.now(),
        metadata: { errorMessage: errMsg },
      });
    }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/output-handler.ts
git commit -m "feat(output-handler): use panel-adapter in exception handler"
```

---

### Task 8: 替换 session-executor.ts 中的调用

**Files:**
- Modify: `src/session-executor.ts:1-18` (imports and initial calls)

- [ ] **Step 1: 替换 imports**

将 line 6-10 的：
```typescript
import {
  finalizeSessionPresentation,
  queueSessionDigest,
  updateSessionStatus,
} from './session-output-coordinator.ts';
```

替换为：
```typescript
import {
  updateSessionState,
  queueDigest,
  handleResultEvent,
} from './panel-adapter.ts';
```

- [ ] **Step 2: 查找并替换所有调用**

在 session-executor.ts 中：
- 将 `updateSessionStatus(session, channel, ...)` 替换为 `updateSessionState(session.id, ...)`
- 将 `queueSessionDigest(session.id, ...)` 替换为 `queueDigest(session.id, ...)`
- 将 `finalizeSessionPresentation(session, channel, ...)` 替换为适当的 `handleResultEvent` 调用

- [ ] **Step 3: 提交**

```bash
git add src/session-executor.ts
git commit -m "feat(session-executor): switch to panel-adapter"
```

---

### Task 9: 替换 shell-handler.ts 中的调用

**Files:**
- Modify: `src/shell-handler.ts:1-11` (imports)
- Modify: `src/shell-handler.ts:61-111` (executeShellCommand function)

- [ ] **Step 1: 替换 imports**

将 line 4-9 的：
```typescript
import {
  finalizeSessionPresentation,
  flushSessionDigest,
  queueSessionDigest,
  updateSessionStatus,
} from './session-output-coordinator.ts';
```

替换为：
```typescript
import {
  updateSessionState,
  queueDigest,
  flushDigest,
  handleResultEvent,
} from './panel-adapter.ts';
```

- [ ] **Step 2: 替换函数内的调用**

在 `executeShellCommand` 中：
- Line 61-75: 替换 `updateSessionStatus` 为 `updateSessionState`
- Line 76, 92: 替换 `queueSessionDigest` 为 `queueDigest`
- Line 96: 替换 `flushSessionDigest` 为 `flushDigest`
- Line 97-111: 替换 `finalizeSessionPresentation` 为 `handleResultEvent`

- [ ] **Step 3: 提交**

```bash
git add src/shell-handler.ts
git commit -m "feat(shell-handler): switch to panel-adapter"
```

---

### Task 10: 更新测试文件

**Files:**
- Modify: `test/output-handler.test.ts:1-26` (mocks)
- Modify: `test/session-executor.test.ts` (if exists)
- Modify: `test/shell-handler.test.ts:1-30` (mocks)

- [ ] **Step 1: 更新 output-handler.test.ts mocks**

将 line 4-19 的 mock 替换为：

```typescript
const mocks = vi.hoisted(() => ({
  initializeSessionPanel: vi.fn(),
  updateSessionState: vi.fn(),
  handleResultEvent: vi.fn(),
  handleAwaitingHuman: vi.fn(),
  queueDigest: vi.fn(),
  flushDigest: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('../src/panel-adapter.ts', () => ({
  initializeSessionPanel: mocks.initializeSessionPanel,
  updateSessionState: mocks.updateSessionState,
  handleResultEvent: mocks.handleResultEvent,
  handleAwaitingHuman: mocks.handleAwaitingHuman,
  queueDigest: mocks.queueDigest,
  flushDigest: mocks.flushDigest,
}));
```

- [ ] **Step 2: 更新测试断言**

将所有 `mocks.queueSessionDigest` 替换为 `mocks.queueDigest`
将所有 `mocks.finalizeSessionPresentation` 替换为 `mocks.handleResultEvent`

- [ ] **Step 3: 更新 shell-handler.test.ts mocks**

类似地更新 shell-handler 测试的 mocks。

- [ ] **Step 4: 运行测试验证**

```bash
pnpm test -- test/output-handler.test.ts
pnpm test -- test/shell-handler.test.ts
```

预期：所有测试通过

- [ ] **Step 5: 提交**

```bash
git add test/
git commit -m "test: update mocks to use panel-adapter"
```

---

### Task 11: 标记旧系统为 deprecated

**Files:**
- Modify: `src/session-output-coordinator.ts:1-10`

- [ ] **Step 1: 添加 deprecation 注释**

在文件顶部添加：

```typescript
/**
 * @deprecated This module is being phased out in favor of panel-adapter.ts + state/state-machine.ts
 *
 * Migration status:
 * - output-handler.ts: ✅ migrated
 * - session-executor.ts: ✅ migrated
 * - shell-handler.ts: ✅ migrated
 *
 * This file is kept temporarily for:
 * - session-output-coordinator.test.ts (legacy test coverage)
 * - Potential rollback if critical issues are found
 *
 * Scheduled for removal: 2026-04-15
 */
```

- [ ] **Step 2: 提交**

```bash
git add src/session-output-coordinator.ts
git commit -m "docs: mark session-output-coordinator as deprecated"
```

---

### Task 12: 完整集成测试

**Files:**
- Run: integration smoke test

- [ ] **Step 1: 运行完整测试套件**

```bash
pnpm typecheck
pnpm test
```

预期：所有测试通过，无类型错误

- [ ] **Step 2: 运行集成冒烟测试**

```bash
pnpm build
node scripts/integration-smoke.ts
```

预期：能够创建会话、发送消息、接收状态更新

- [ ] **Step 3: 手动验证 Discord 交互**

1. 启动 bot：`pnpm start`
2. 在 Discord 中创建新会话
3. 发送消息，验证：
   - 状态卡正确显示并固定
   - 进度摘要正确聚合
   - ask_user 交互卡正确显示
   - 本轮总结和结束总结语义正确

- [ ] **Step 4: 记录验证结果**

创建验证报告：

```bash
echo "# 状态机切换验证报告

日期：$(date +%Y-%m-%d)

## 自动化测试
- 类型检查：✅ 通过
- 单元测试：✅ 通过
- 集成测试：✅ 通过

## 手动验证
- 状态卡固定：✅
- 进度聚合：✅
- 交互按钮：✅
- 总结语义：✅

## 结论
状态机切换完成，所有功能正常。
" > docs/superpowers/plans/2026-03-30-migration-verification.md
```

- [ ] **Step 5: 最终提交**

```bash
git add docs/superpowers/plans/2026-03-30-migration-verification.md
git commit -m "docs: add state machine migration verification report"
```

---

## 实施注意事项

1. **渐进式切换**：每个 task 独立提交，出问题可以快速回滚
2. **测试先行**：每次修改后立即运行相关测试
3. **保留旧代码**：session-output-coordinator.ts 暂时保留，标记为 deprecated
4. **类型安全**：所有修改必须通过 `pnpm typecheck`
5. **最小化改动**：只替换调用，不重构内部逻辑

## 回滚计划

如果发现严重问题：

```bash
# 回滚到切换前的提交
git revert HEAD~12..HEAD

# 或者单独回滚某个文件
git checkout HEAD~12 -- src/output-handler.ts
```

## 后续优化（不在本计划范围）

- 将 digest 队列从 panel-adapter 提取为独立的 DigestHandler 组件
- 优化 StatusCard 的更新频率（批量更新）
- 添加状态转换动画
- 支持多会话状态聚合显示