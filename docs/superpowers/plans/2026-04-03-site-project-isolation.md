# Site Project Isolation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让根工程的 test、typecheck、build、lint 只作用于根工程本身，不再把 `site` 当作同一项目。

**Architecture:** 保持 `site` 为已有的独立子工程，根工程通过显式配置边界来避免扫描或执行 `site`。优先修改根配置而不是引入工作区编排。

**Tech Stack:** Vitest、ESLint、TypeScript、tsup

---

## Chunk 1: 根工程边界约束

### Task 1: 用测试锁定根配置边界

**Files:**
- Modify: `test/vitest-config.test.ts`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`
- Modify: `eslint.config.js`

- [ ] **Step 1: 先写失败测试**
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小修改根配置，显式排除 `site`**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 运行根工程相关验证命令**
