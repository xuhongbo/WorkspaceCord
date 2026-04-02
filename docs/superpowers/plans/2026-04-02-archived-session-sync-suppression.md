# Archived Session Sync Suppression Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已归档的 provider 会话不再被本地自动发现链路重新创建为 Discord 频道。

**Architecture:** 为归档记录补充 `providerSessionId`，并提供“该 provider 会话是否已归档”的查询；自动发现链路中的 `session-sync` 与 `registerLocalSession(...)` 在补建前统一检查该状态，命中则跳过。旧归档记录不回填，修复仅对后续新归档生效。

**Tech Stack:** TypeScript、discord.js、Vitest

---

### Task 1: 先补失败测试覆盖归档防重建

**Files:**
- Modify: `test/session-sync.test.ts`
- Modify: `test/thread-manager-register-local-session.test.ts`
- Create: `test/archive-manager.test.ts`

- [ ] **Step 1: 为 archive-manager 写失败测试，验证归档记录包含 providerSessionId 且可查询**
- [ ] **Step 2: 为 session-sync 写失败测试，验证已归档 provider 会话不会被补建**
- [ ] **Step 3: 为 registerLocalSession 写失败测试，验证已归档 provider 会话不会被自动注册**
- [ ] **Step 4: 运行相关测试并确认失败原因符合预期**

### Task 2: 最小实现归档防重建逻辑

**Files:**
- Modify: `src/types.ts`
- Modify: `src/archive-manager.ts`
- Modify: `src/session-sync.ts`
- Modify: `src/thread-manager.ts`

- [ ] **Step 1: 为 ArchivedSession 增加可选 providerSessionId 字段，保持旧数据兼容**
- [ ] **Step 2: 归档时写入 providerSessionId，并提供已归档查询函数**
- [ ] **Step 3: 在 session-sync 补建前跳过已归档 provider 会话**
- [ ] **Step 4: 在 registerLocalSession 自动注册前跳过已归档 provider 会话**

### Task 3: 运行验证

**Files:**
- Test: `test/archive-manager.test.ts`
- Test: `test/session-sync.test.ts`
- Test: `test/thread-manager-register-local-session.test.ts`

- [ ] **Step 1: 跑新增与相关回归测试**
- [ ] **Step 2: 跑类型检查**
