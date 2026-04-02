# Recent Session Sync Window Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex 与 Claude 的自动同步都只补建最近三天内最后活跃的会话

**Architecture:** 在 `session-sync` 统一执行最近三天窗口过滤，让同步策略集中在一处；同时修复 `codex-session-discovery` 对 ISO `updated_at` 的解析，确保 Codex 能提供可比较的最后活跃时间。现有归档去重逻辑保持不变，与新窗口规则叠加生效。
后续再把窗口天数提取为统一配置项 `SESSION_SYNC_RECENT_DAYS`，默认保留 3 天，`0` 表示关闭限制。

**Tech Stack:** TypeScript、Vitest、discord.js

---

### Task 1: 先补失败测试覆盖三天窗口规则

**Files:**
- Modify: `/Users/ld/Documents/github/agentcord/test/session-sync.test.ts`
- Modify: `/Users/ld/Documents/github/agentcord/test/codex-session-discovery.test.ts`

- [ ] **Step 1: 为 Codex 索引补失败测试，验证 ISO `updated_at` 会被解析**
- [ ] **Step 2: 为 session-sync 补失败测试，验证超过三天的 Codex 会话不会被同步**
- [ ] **Step 3: 为 session-sync 补失败测试，验证超过三天的 Claude 会话不会被同步**
- [ ] **Step 4: 运行相关测试并确认按预期失败**

### Task 2: 做最小实现

**Files:**
- Modify: `/Users/ld/Documents/github/agentcord/src/codex-session-discovery.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/session-sync.ts`

- [ ] **Step 1: 支持把 Codex 索引中的 ISO `updated_at` 解析为毫秒时间戳**
- [ ] **Step 2: 在 session-sync 增加最近三天窗口过滤辅助逻辑**
- [ ] **Step 3: 让 Claude 与 Codex 在补建前都经过同一窗口判断**

### Task 3: 回归验证

**Files:**
- Test: `/Users/ld/Documents/github/agentcord/test/codex-session-discovery.test.ts`
- Test: `/Users/ld/Documents/github/agentcord/test/session-sync.test.ts`

- [ ] **Step 1: 跑相关测试**
- [ ] **Step 2: 跑类型检查**

### Task 4: 把最近窗口做成配置项

**Files:**
- Modify: `/Users/ld/Documents/github/agentcord/src/config.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/types.ts`
- Modify: `/Users/ld/Documents/github/agentcord/src/session-sync.ts`
- Modify: `/Users/ld/Documents/github/agentcord/.env.example`
- Modify: `/Users/ld/Documents/github/agentcord/test/session-sync.test.ts`

- [ ] **Step 1: 为 session-sync 增加失败测试，验证 `SESSION_SYNC_RECENT_DAYS=0` 时允许同步超过三天的旧会话**
- [ ] **Step 2: 在 config 中新增统一配置项并更新类型声明**
- [ ] **Step 3: 让 session-sync 使用配置值而不是写死 3 天**
- [ ] **Step 4: 更新 `.env.example` 示例说明**
- [ ] **Step 5: 运行相关测试与类型检查**
