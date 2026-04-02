# Discord 官方交互对齐 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `workspacecord` 的 `Discord` 用户可见交互在不改变现有产品模型的前提下，对齐官方 `Claude Code Discord` 插件的入站反馈、文本分块、引用回复、附件懒下载与最终完成通知语义。

**Architecture:** 新增统一消息层，拆成 `inbound-envelope`、`attachment-inbox`、`delivery-policy`、`delivery`、`session-message-context` 五个边界清晰的模块。`message-handler`、`output-handler`、`panel-adapter`、`summary-handler` 不再各自维护消息投递规则，而是统一交给 `delivery-policy` 和 `delivery`；提供方侧则通过 `session-message-context` 接收稳定的 `Discord` 语义说明。

**Tech Stack:** `TypeScript`、`discord.js`、`vitest`、现有 `workspacecord` 全局配置系统、官方参考副本 `tmp/claude-plugins-official/external_plugins/discord/`

---

## File Map

**Create:**
- `/Users/ld/Documents/github/agentcord/src/discord/delivery-policy.ts` — 官方式分块、引用、附件首块挂载与发送计划生成。
- `/Users/ld/Documents/github/agentcord/src/discord/delivery.ts` — 统一消息发送、编辑、`typing`、反应、会话级投递状态。
- `/Users/ld/Documents/github/agentcord/src/discord/inbound-envelope.ts` — 原始 `Discord` 消息到统一消息包文本的转换。
- `/Users/ld/Documents/github/agentcord/src/discord/attachment-inbox.ts` — 附件索引、按消息/附件查询、下载路径与文件名净化。
- `/Users/ld/Documents/github/agentcord/src/discord/session-message-context.ts` — 提供方可见的 `Discord` 语义提示片段。
- `/Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts` — 分块、引用、附件计划单测。
- `/Users/ld/Documents/github/agentcord/test/delivery.test.ts` — 统一投递与编辑降级单测。
- `/Users/ld/Documents/github/agentcord/test/inbound-envelope.test.ts` — 入站消息包渲染单测。
- `/Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts` — 索引、路径、文件名净化单测。
- `/Users/ld/Documents/github/agentcord/test/session-message-context.test.ts` — 提示词片段单测。

**Modify:**
- `/Users/ld/Documents/github/agentcord/src/config.ts` — 暴露 `ackReaction`、`replyToMode`、`textChunkLimit`、`chunkMode`。
- `/Users/ld/Documents/github/agentcord/src/global-config.ts` — 校验新增配置键与取值约束。
- `/Users/ld/Documents/github/agentcord/src/utils.ts` — 移除旧 `splitMessage` 责任，保留仅通用工具或转调新策略模块。
- `/Users/ld/Documents/github/agentcord/src/message-handler.ts` — 改为 `typing` + 可配置反应 + `inbound-envelope` + 附件登记；删除图片 `base64`/小文本自动内联。
- `/Users/ld/Documents/github/agentcord/src/output-handler.ts` — 文本与附件统一交给 `delivery-policy` / `delivery`；`image_file` 不再直接 `channel.send()`。
- `/Users/ld/Documents/github/agentcord/src/panel-adapter.ts` — 总结、摘要与系统消息统一走 `delivery`。
- `/Users/ld/Documents/github/agentcord/src/discord/summary-handler.ts` — 从“自己拆分+自己发送”收敛为“构造摘要载荷并交给 `delivery`”。
- `/Users/ld/Documents/github/agentcord/src/thread-manager.ts` — 接入 `session-message-context.ts` 输出到 `systemPromptParts`。
- `/Users/ld/Documents/github/agentcord/src/cli.ts` — 预留或接入 `workspacecord attachment fetch` 命令入口。
- `/Users/ld/Documents/github/agentcord/src/command-handlers.ts` 或对应命令文件 — 如现有命令树要求，在这里注册 `attachment fetch`。
- `/Users/ld/Documents/github/agentcord/test/message-handler.test.ts`
- `/Users/ld/Documents/github/agentcord/test/output-handler.test.ts`
- `/Users/ld/Documents/github/agentcord/test/summary-handler.test.ts`
- `/Users/ld/Documents/github/agentcord/test/panel-adapter.test.ts`
- `/Users/ld/Documents/github/agentcord/test/global-config.test.ts`
- `/Users/ld/Documents/github/agentcord/test/config-defaults.test.ts`

**Reference only:**
- `/Users/ld/Documents/github/agentcord/tmp/claude-plugins-official/external_plugins/discord/README.md`
- `/Users/ld/Documents/github/agentcord/tmp/claude-plugins-official/external_plugins/discord/ACCESS.md`
- `/Users/ld/Documents/github/agentcord/tmp/claude-plugins-official/external_plugins/discord/server.ts`

---

## Chunk 1: 主聊天链路与回合结束主路径对齐

### Task 1: 配置与策略基础设施

**Files:**
- Create: `/Users/ld/Documents/github/agentcord/src/discord/delivery-policy.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/config.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/global-config.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/utils.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/global-config.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/config-defaults.test.ts`

- [ ] **Step 1: 写失败测试，锁定官方式分块与配置约束**

```ts
expect(splitDiscordMessage('a\n\n' + 'b'.repeat(1990), 2000, 'newline')).toEqual([...])
expect(buildDeliveryPlan({ mode: 'user_reply', replyToMode: 'first' }).chunks.length).toBe(2)
expect(validateConfigValue('TEXT_CHUNK_LIMIT', '2500')).toContain('Expected')
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts /Users/ld/Documents/github/agentcord/test/global-config.test.ts /Users/ld/Documents/github/agentcord/test/config-defaults.test.ts`
Expected: 失败，提示缺少 `delivery-policy` 模块或新增配置键未实现。

- [ ] **Step 3: 以最小实现补齐策略模块与配置键**

实现内容：
- 官方式 `newline` / `length` 分块。
- `replyToMode = off | first | all`。
- 附件最多 10 个、25MB、仅首块挂载。
- 新配置键：`ACK_REACTION`、`REPLY_TO_MODE`、`TEXT_CHUNK_LIMIT`、`CHUNK_MODE`，其中 `CHUNK_MODE` 默认值按官方 `server.ts` 对齐为 `length`。

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts /Users/ld/Documents/github/agentcord/test/global-config.test.ts /Users/ld/Documents/github/agentcord/test/config-defaults.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交基础设施变更**

```bash
git add /Users/ld/Documents/github/agentcord/src/config.ts \
        /Users/ld/Documents/github/agentcord/src/global-config.ts \
        /Users/ld/Documents/github/agentcord/src/utils.ts \
        /Users/ld/Documents/github/agentcord/src/discord/delivery-policy.ts \
        /Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts \
        /Users/ld/Documents/github/agentcord/test/global-config.test.ts \
        /Users/ld/Documents/github/agentcord/test/config-defaults.test.ts
git commit -m "feat: add discord delivery policy foundation"
```

### Task 2: 统一投递层与回合结束最终消息路径

**Files:**
- Create: `/Users/ld/Documents/github/agentcord/src/discord/delivery.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/output-handler.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/panel-adapter.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/discord/summary-handler.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/delivery.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/output-handler.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/panel-adapter.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/summary-handler.test.ts`

- [ ] **Step 1: 写失败测试，锁定“进度可编辑、结果必须新发”语义**
- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/delivery.test.ts /Users/ld/Documents/github/agentcord/test/output-handler.test.ts /Users/ld/Documents/github/agentcord/test/panel-adapter.test.ts /Users/ld/Documents/github/agentcord/test/summary-handler.test.ts`
Expected: 失败，提示缺少统一投递层或旧模块仍直接发送。

- [ ] **Step 3: 实现统一投递层**

实现内容：
- `sendTyping(sessionChannel)`：失败吞掉。
- `sendAckReaction(message, reaction)`：空字符串直接跳过。
- `deliver(plan)`：统一发送文本块与首块附件。
- `progress_update` 优先编辑 `editTargetMessageId`，其次回退到会话级最近进度消息。
- `user_reply` / `summary` / `system_notice` / `log` 始终新发，并更新最近最终消息状态。
- `SummaryHandler` 只保留摘要内容组织，不再自己做分块发送。

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/delivery.test.ts /Users/ld/Documents/github/agentcord/test/output-handler.test.ts /Users/ld/Documents/github/agentcord/test/panel-adapter.test.ts /Users/ld/Documents/github/agentcord/test/summary-handler.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交统一投递层变更**

```bash
git add /Users/ld/Documents/github/agentcord/src/discord/delivery.ts \
        /Users/ld/Documents/github/agentcord/src/output-handler.ts \
        /Users/ld/Documents/github/agentcord/src/panel-adapter.ts \
        /Users/ld/Documents/github/agentcord/src/discord/summary-handler.ts \
        /Users/ld/Documents/github/agentcord/test/delivery.test.ts \
        /Users/ld/Documents/github/agentcord/test/output-handler.test.ts \
        /Users/ld/Documents/github/agentcord/test/panel-adapter.test.ts \
        /Users/ld/Documents/github/agentcord/test/summary-handler.test.ts
git commit -m "feat: unify discord delivery and final result messaging"
```

### Task 3: 入站消息包与懒下载登记

**Files:**
- Create: `/Users/ld/Documents/github/agentcord/src/discord/inbound-envelope.ts`
- Create: `/Users/ld/Documents/github/agentcord/src/discord/attachment-inbox.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/message-handler.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/inbound-envelope.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/message-handler.test.ts`

- [ ] **Step 1: 写失败测试，锁定“附件只登记不内联”语义**
- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/inbound-envelope.test.ts /Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts /Users/ld/Documents/github/agentcord/test/message-handler.test.ts`
Expected: 失败，提示附件仍被自动抓取或新模块不存在。

- [ ] **Step 3: 实现入站封装与附件索引**

实现内容：
- 把消息渲染为 `<discord ...>...</discord>` 文本包。
- 附件索引至少记录 `sessionId`、`messageId`、`attachmentId`、文件名、类型、大小、源地址。
- `message-handler` 改为：授权/限流后先 `typing`，再按配置发反应，然后登记附件并把 `renderedPrompt` 交给执行器。
- 删除图片 `base64` 和小文本附件读取逻辑。

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/inbound-envelope.test.ts /Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts /Users/ld/Documents/github/agentcord/test/message-handler.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交入站语义变更**

```bash
git add /Users/ld/Documents/github/agentcord/src/discord/inbound-envelope.ts \
        /Users/ld/Documents/github/agentcord/src/discord/attachment-inbox.ts \
        /Users/ld/Documents/github/agentcord/src/message-handler.ts \
        /Users/ld/Documents/github/agentcord/test/inbound-envelope.test.ts \
        /Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts \
        /Users/ld/Documents/github/agentcord/test/message-handler.test.ts
git commit -m "feat: add discord inbound envelope and attachment registry"
```

---

## Chunk 2: 附件抓取入口与提供方语义打通

### Task 4: 本地附件抓取命令

**Files:**
- Modify: `/Users/ld/Documents/github/agentcord/src/cli.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/command-handlers.ts` 或命令入口对应文件
- Modify: `/Users/ld/Documents/github/agentcord/src/discord/attachment-inbox.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/command-handlers.test.ts`

- [ ] **Step 1: 写失败测试，锁定 `--attachment` 与 `--all` 语义**
- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts /Users/ld/Documents/github/agentcord/test/command-handlers.test.ts`
Expected: 失败，提示 `attachment fetch` 命令不存在。

- [ ] **Step 3: 实现命令入口**

实现内容：
- `workspacecord attachment fetch --session <id> --message <id> --attachment <id>` 默认单附件。
- `--all` 显式下载该消息全部附件。
- 校验消息/附件/会话绑定关系。
- 下载到 `~/.workspacecord/inbox/<session-id>/`。

- [ ] **Step 4: 再跑测试确认通过**
- [ ] **Step 5: 提交附件抓取命令**

---

### Task 5: 提供方语义注入

**Files:**
- Create: `/Users/ld/Documents/github/agentcord/src/discord/session-message-context.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/thread-manager.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/session-message-context.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/thread-manager-local-fields.test.ts`

- [ ] **Step 1: 写失败测试，锁定系统提示必须包含附件懒下载与完成通知语义**
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 以最小实现接入 `systemPromptParts`**
- [ ] **Step 4: 再跑测试确认通过**
- [ ] **Step 5: 提交提示词接线变更**

---

## Chunk 3: 系统通知全面并轨与回归收口

### Task 6: 收口剩余直接发送点

**Files:**
- Modify: `/Users/ld/Documents/github/agentcord/src/bot.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/hook-health-check.ts`
- Modify: 其余 `rg "channel.send\(|messages.edit\(|react\("` 命中的普通消息路径
- Test: `/Users/ld/Documents/github/agentcord/test/bot-routing.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/bot-startup.test.ts`

- [ ] **Step 1: 写失败测试，锁定系统通知也走统一投递规则**
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 迁移剩余输出点到 `delivery`**
- [ ] **Step 4: 再跑测试确认通过**
- [ ] **Step 5: 提交系统通知并轨**

### Task 7: 全量回归

**Files:**
- Test only: `/Users/ld/Documents/github/agentcord/test/*.test.ts`

- [ ] **Step 1: 运行本特性相关测试集**

Run: `pnpm vitest run /Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts /Users/ld/Documents/github/agentcord/test/delivery.test.ts /Users/ld/Documents/github/agentcord/test/inbound-envelope.test.ts /Users/ld/Documents/github/agentcord/test/attachment-inbox.test.ts /Users/ld/Documents/github/agentcord/test/message-handler.test.ts /Users/ld/Documents/github/agentcord/test/output-handler.test.ts /Users/ld/Documents/github/agentcord/test/panel-adapter.test.ts /Users/ld/Documents/github/agentcord/test/summary-handler.test.ts /Users/ld/Documents/github/agentcord/test/command-handlers.test.ts`
Expected: PASS。

- [ ] **Step 2: 运行全量测试**

Run: `pnpm test`
Expected: PASS。

- [ ] **Step 3: 运行类型检查**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: 提交最终收口**

```bash
git add -A
git commit -m "feat: align discord interactions with official plugin"
```
