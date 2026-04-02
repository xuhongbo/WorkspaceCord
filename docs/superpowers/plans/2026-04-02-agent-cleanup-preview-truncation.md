# Agent Cleanup Preview Truncation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/agent cleanup` 在候选会话很多时仍能稳定返回预览，不再因正文过长导致交互失败。

**Architecture:** 保持现有 cleanup 交互流程不变，只收敛预览文案生成逻辑：对“将跳过”和“将归档”列表做显示上限控制，并在超出时追加省略汇总提示。回归测试放在命令处理矩阵测试中，直接验证回复正文被截断且保留摘要信息。

**Tech Stack:** TypeScript、discord.js、Vitest

---

### Task 1: 为 cleanup 预览添加超长回归测试

**Files:**
- Modify: `test/command-handlers-matrix.test.ts`
- Test: `test/command-handlers-matrix.test.ts`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 运行单测并确认因未截断而失败**
- [ ] **Step 3: 最小实现截断逻辑**
- [ ] **Step 4: 重跑单测并确认通过**

### Task 2: 实现 cleanup 预览截断

**Files:**
- Modify: `src/command-handlers.ts`
- Test: `test/command-handlers-matrix.test.ts`

- [ ] **Step 1: 为预览列表增加显示上限常量与省略提示**
- [ ] **Step 2: 保持现有文案结构，仅在列表过长时截断**
- [ ] **Step 3: 验证现有 cleanup 相关测试仍通过**
