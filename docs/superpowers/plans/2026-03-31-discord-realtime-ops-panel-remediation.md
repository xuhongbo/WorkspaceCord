# Discord Realtime Ops Panel Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复实时作战面板剩余偏离，使等待人工闭环、状态机语义和监控验证达到设计要求。

**Architecture:** 先收口等待人工链路，确保所有 `awaiting_human` 场景统一走同一交互卡入口；再修正状态机优先级、正式/推断状态与阶段文案传递；最后补足状态卡接管行为与关键测试，提升整体验证可信度。

**Tech Stack:** TypeScript, Discord.js, Vitest, 现有 provider 抽象层

---

## Chunk 1: 等待人工闭环收口

### Task 1: 统一 `awaiting_human` 入口到交互卡

**Files:**
- Modify: `src/output-handler.ts`
- Modify: `src/session-executor.ts`
- Modify: `src/panel-adapter.ts`
- Test: `test/output-handler.test.ts`
- Test: `test/session-executor.test.ts`

- [x] **Step 1: 写失败测试，约束 `ask_user` 走统一交互入口**

在 `test/output-handler.test.ts` 增加断言：
- `ask_user` 时调用 `handleAwaitingHuman(...)`
- 不再只直接 `channel.send(...)` 问题卡

Run: `npm test -- test/output-handler.test.ts`
Expected: 新用例失败

- [x] **Step 2: 修改 `src/output-handler.ts` 的 `ask_user` 分支**

要求：
- 保留状态更新
- 调用 `handleAwaitingHuman(sessionId, event.questionsJson, ...)`
- 若仍保留问题卡，必须明确为同一闭环的一部分；否则删除旧直发逻辑，避免双入口

- [x] **Step 3: 写失败测试，约束监督流阻塞场景也会挂交互卡**

在 `test/session-executor.test.ts` 增加断言：
- `decision.shouldAskHuman`
- `blocked`
- `continue without goal`
这些路径进入等待人工时，会调用 `handleAwaitingHuman(...)`

Run: `npm test -- test/session-executor.test.ts`
Expected: 新用例失败

- [x] **Step 4: 修改 `src/session-executor.ts`**

把以下仅改状态的路径改为“状态 + 交互卡”：
- `resolveAskUserIfPossible(...)`
- `decision.status === 'blocked'`
- 达到 continuation limit
- `executeSessionContinue(...)` 中无 goal 的阻塞

- [x] **Step 5: 运行聚焦测试**

Run: `npm test -- test/output-handler.test.ts test/session-executor.test.ts`
Expected: 全部通过

- [x] **Step 6: 提交**

```bash
git add src/output-handler.ts src/session-executor.ts test/output-handler.test.ts test/session-executor.test.ts
git commit -m "fix: unify awaiting human flow through interaction cards"
```

### Task 2: 用 `currentInteractionMessageId` 防旧消息与错消息

**Files:**
- Modify: `src/button-handler.ts`
- Modify: `src/panel-adapter.ts`
- Test: `test/button-handler.test.ts`

- [x] **Step 1: 写失败测试覆盖旧消息点击**

在 `test/button-handler.test.ts` 增加：
- 当前消息 id 与 `session.currentInteractionMessageId` 不一致时返回“已过期”
- `humanResolved=true` 时仍返回已处理
- 轮次正确但消息 id 错误时不得继续会话

Run: `npm test -- test/button-handler.test.ts`
Expected: 新用例失败

- [x] **Step 2: 修改 `src/button-handler.ts`**

增加校验：
- `interaction.message.id === session.currentInteractionMessageId`
- 不匹配则拒绝处理

- [x] **Step 3: 检查 `src/panel-adapter.ts` 写入逻辑**

确保 `handleAwaitingHuman(...)` 写入 `currentInteractionMessageId`，隐藏旧交互卡时清理旧 id。

- [x] **Step 4: 运行聚焦测试**

Run: `npm test -- test/button-handler.test.ts test/panel-adapter.test.ts`
Expected: 全部通过

- [x] **Step 5: 提交**

```bash
git add src/button-handler.ts src/panel-adapter.ts test/button-handler.test.ts test/panel-adapter.test.ts
git commit -m "fix: validate active awaiting-human interaction message"
```

## Chunk 2: 状态机语义修复

### Task 3: 让状态机真正使用优先级转换

**Files:**
- Modify: `src/state/state-machine.ts`
- Test: `test/state-machine.test.ts`

- [x] **Step 1: 新建状态机测试文件**

创建 `test/state-machine.test.ts`，覆盖：
- 低优先状态不能覆盖高优先状态
- 高优先状态可以打断低优先状态
- `session_ended` 可落到 `offline`
- `human_resolved` 的例外行为

Run: `npm test -- test/state-machine.test.ts`
Expected: 失败（文件或用例失败）

- [x] **Step 2: 修改 `src/state/state-machine.ts`**

在 `applyPlatformEvent(...)` 中接入 `shouldTransition(...)`，并为必要例外写清规则。

- [x] **Step 3: 运行聚焦测试**

Run: `npm test -- test/state-machine.test.ts`
Expected: 通过

- [x] **Step 4: 提交**

```bash
git add src/state/state-machine.ts test/state-machine.test.ts
git commit -m "fix: enforce state transition priorities in state machine"
```

### Task 4: 落实正式态 / 推断态，并保留阶段文案

**Files:**
- Modify: `src/state/types.ts`
- Modify: `src/state/event-normalizer.ts`
- Modify: `src/state/state-machine.ts`
- Test: `test/event-normalizer.codex.test.ts`
- Test: `test/state-machine.test.ts`

- [x] **Step 1: 写失败测试**

补测试覆盖：
- `observedState` 回退路径写为推断态
- `codex-permission` 启发式写为推断态
- `metadata.phase` 可覆盖默认阶段标签

Run: `npm test -- test/event-normalizer.codex.test.ts test/state-machine.test.ts`
Expected: 新用例失败

- [x] **Step 2: 修改类型与归一层**

为平台事件补足必要标记，例如：
- `sourceKind` / `inference` / `isInferred`

不要复用现有 provider `source` 字段语义。

- [x] **Step 3: 修改状态机写入逻辑**

要求：
- 推断态进入快照时写 `source: 'inferred'`
- 正式态写 `source: 'formal'`
- 若 `metadata.phase` 存在，则优先展示该阶段文案

- [x] **Step 4: 修正 `toPlatformEvent(..., 'codex')`**

如果该分支仍需要保留，必须：
- 明确支持哪些 `codex` 事件
- 或删除错误分支并限制入口

- [x] **Step 5: 运行聚焦测试**

Run: `npm test -- test/event-normalizer.codex.test.ts test/state-machine.test.ts`
Expected: 全部通过

- [x] **Step 6: 提交**

```bash
git add src/state/types.ts src/state/event-normalizer.ts src/state/state-machine.ts test/event-normalizer.codex.test.ts test/state-machine.test.ts
git commit -m "fix: add inferred-state semantics and preserve phase metadata"
```

## Chunk 3: 状态卡与展示收口

### Task 5: 修复状态卡接管旧消息时的残留问题

**Files:**
- Modify: `src/discord/status-card.ts`
- Modify: `src/panel-adapter.ts`
- Test: `test/panel-adapter.test.ts`

- [x] **Step 1: 写失败测试**

补测试验证：
- adopt 旧消息后会清理 `components`
- 必要时重新 `pin`
- 初始化接管时不会退化成带旧按钮的状态卡

Run: `npm test -- test/panel-adapter.test.ts`
Expected: 新用例失败

- [x] **Step 2: 修改 `src/discord/status-card.ts`**

要求：
- 编辑旧消息时带上 `components: []`
- adopt 场景下确保消息被 pin；若无法 pin，至少写清降级策略

- [x] **Step 3: 修改 `src/panel-adapter.ts`**

确保接管旧消息时传递所需上下文，并同步保存正确的状态卡消息 id。

- [x] **Step 4: 运行聚焦测试**

Run: `npm test -- test/panel-adapter.test.ts`
Expected: 通过

- [x] **Step 5: 提交**

```bash
git add src/discord/status-card.ts src/panel-adapter.ts test/panel-adapter.test.ts
git commit -m "fix: clean up adopted status cards and enforce pinned state"
```

### Task 6: 接上 `validate()`，约束状态卡只表达状态

**Files:**
- Modify: `src/discord/status-card.ts`
- Test: `test/status-card.test.ts`

- [x] **Step 1: 新建失败测试**

创建 `test/status-card.test.ts`，覆盖：
- 长文本拒绝
- 代码块拒绝
- 文件列表 / `diff` 拒绝

Run: `npm test -- test/status-card.test.ts`
Expected: 失败

- [x] **Step 2: 修改 `src/discord/status-card.ts`**

要求：
- 在 `buildEmbed()` 或 `update()` 前统一调用 `validate()`
- 补足禁止项检查

- [x] **Step 3: 运行聚焦测试**

Run: `npm test -- test/status-card.test.ts`
Expected: 通过

- [x] **Step 4: 提交**

```bash
git add src/discord/status-card.ts test/status-card.test.ts
git commit -m "fix: enforce status-card content boundaries"
```

## Chunk 4: 验证补强

### Task 7: 给 `codex-log-monitor` 补直接测试

**Files:**
- Test: `test/codex-log-monitor.test.ts`
- Modify: `src/monitors/codex-log-monitor.ts`（仅在测试暴露需要时做最小改动）

- [x] **Step 1: 写测试覆盖核心风险点**

覆盖：
- 增量偏移读取
- partial 行拼接
- `approvalTimer` 推断
- `task_complete -> attention/idle`
- 失活清理

Run: `npm test -- test/codex-log-monitor.test.ts`
Expected: 失败

- [x] **Step 2: 如有必要做最小实现调整**

仅允许为可测性增加极小注入点；不要重构行为。

- [x] **Step 3: 运行聚焦测试**

Run: `npm test -- test/codex-log-monitor.test.ts`
Expected: 通过

- [x] **Step 4: 提交**

```bash
git add src/monitors/codex-log-monitor.ts test/codex-log-monitor.test.ts
git commit -m "test: cover codex log monitor edge cases"
```

### Task 8: 修正 `monitor-e2e` 假阳性

**Files:**
- Modify: `scripts/monitor-e2e.ts`
- Modify: `scripts/local-acceptance-suite.ts`
- Test/Verify: `local-acceptance/*.json`

- [x] **Step 1: 修改 `scripts/monitor-e2e.ts`**

要求：
- 只要存在 `runError`、超时、无 completion 等失败条件，就必须非零退出

- [x] **Step 2: 修改 `scripts/local-acceptance-suite.ts`**

要求：
- 不只看退出码，也要看结果文件中的失败字段

- [x] **Step 3: 运行脚本验证**

Run: `node --experimental-strip-types scripts/monitor-e2e.ts`
Run: `node --experimental-strip-types scripts/local-acceptance-suite.ts`
Expected: 失败场景不会再被记为成功

- [x] **Step 4: 提交**

```bash
git add scripts/monitor-e2e.ts scripts/local-acceptance-suite.ts
git commit -m "fix: fail acceptance when monitor e2e reports errors"
```

## 最终验证

### Task 9: 全量验证与审计回归

**Files:**
- Verify only

- [x] **Step 1: 运行单测**

Run: `npm test`
Expected: 全部通过

- [x] **Step 2: 运行类型检查**

Run: `npm run typecheck`
Expected: 退出码 0

- [x] **Step 3: 运行构建**

Run: `npm run build`
Expected: 退出码 0

- [x] **Step 4: 运行关键冒烟**

Run: `node --experimental-strip-types scripts/integration-smoke.ts`
Expected: 至少覆盖 Codex monitor 思考/执行/完成 或等待人工中的关键状态变化

- [x] **Step 5: 记录修复结果**

更新或新增：
- `docs/superpowers/plans/2026-03-30-migration-verification.md`

写清：
- 已修复偏离
- 剩余风险
- 验证命令与结果

- [x] **Step 6: 提交**

```bash
git add docs/superpowers/plans/2026-03-30-migration-verification.md
git commit -m "docs: record realtime ops panel remediation verification"
```
