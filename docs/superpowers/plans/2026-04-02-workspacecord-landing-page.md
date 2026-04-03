# workspacecord 官网实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/Users/ld/Documents/github/agentcord/site` 中实现一个未来感单页官网，并把首屏动画重构为清楚表达“多个项目 + 单项目多 session”的分镜式流程演示。

**Architecture:** 保持独立站点目录与单页结构不变，重点重做首屏主视觉的数据模型和动画编排，让终端命令先发生，再映射到 Discord 服务器，再聚焦单项目展开主会话与子线程，最后收束到历史归档。

**Tech Stack:** React、Vite、TypeScript、Tailwind CSS、Framer Motion

---

## 文件结构

- Modify: `site/src/lib/workflow-steps.ts`
- Modify: `site/src/components/hero/workflow-demo.tsx`
- Modify: `site/src/components/hero/hero-section.tsx`
- Modify: `site/src/index.css`
- Modify: `site/test/workflow-steps.test.ts`
- Modify: `site/test/app.test.tsx`

---

## Chunk 1: 首屏动画数据模型

### Task 1: 重定义工作流步骤状态模型

**Files:**
- Modify: `site/src/lib/workflow-steps.ts`
- Modify: `site/test/workflow-steps.test.ts`

- [ ] **Step 1: 把步骤从并列高亮改为分镜阶段**
  - 挂载多个项目
  - 映射到 Discord
  - 聚焦单项目并展开 session
  - 归档历史

- [ ] **Step 2: 为每个阶段补充项目 / session 数据模型**
  - 多项目列表
  - 选中项目
  - 主会话
  - 子线程

- [ ] **Step 3: 先写失败测试验证步骤结构与层级信息**

---

## Chunk 2: 重做 Hero 与分镜式交互动画

### Task 2: 重构首屏主视觉与交互

**Files:**
- Modify: `site/src/components/hero/workflow-demo.tsx`
- Modify: `site/src/components/hero/hero-section.tsx`
- Modify: `site/src/index.css`
- Modify: `site/test/app.test.tsx`

- [ ] **Step 1: 把主视觉改成从左到右的连续流动结构**
  - 左：终端
  - 中：Discord 服务器与多个项目
  - 右：单项目下的主会话 / 子线程

- [ ] **Step 2: 加入“多个项目 -> 单项目 -> 多 session”分镜切换**
  - 默认自动轮播
  - 悬停步骤时停留在当前场景

- [ ] **Step 3: 用视觉转场强调映射关系**
  - 终端输出后才出现 Discord 结构
  - 选中项目后才展开 session
  - 完成后收束到历史归档

- [ ] **Step 4: 调整文案与标题辅助语，避免并列面板误导**

---

## Chunk 3: 验证与复查

### Task 3: 测试、构建与浏览器复看

**Files:**
- Modify: `site/src/**/*`（按需要）

- [ ] **Step 1: 运行测试**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm test`
Expected: 测试通过，验证步骤结构和页面文案

- [ ] **Step 2: 执行生产构建**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm build`
Expected: 构建成功，无类型或打包报错

- [ ] **Step 3: 浏览器复看动画表达**
  - 确认用户能看懂多个项目
  - 确认用户能看懂单项目多 session
  - 确认终端先发生、Discord 后承接

