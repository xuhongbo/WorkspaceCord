# workspacecord 官网实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/Users/ld/Documents/github/agentcord/site` 中实现一个未来感单页官网，包含可交互的工作流首屏动画、核心介绍区块与快速开始入口。

**Architecture:** 在现有仓库中新建独立前端站点目录，采用单页结构。首屏使用组件化的工作流演示面板表达“本地终端 -> Discord -> 主代理 -> 子代理 -> 历史归档”，其余区块保持简洁并围绕转化到快速开始组织。

**Tech Stack:** React、Vite、TypeScript、Tailwind CSS、Framer Motion

---

## 文件结构

- Create: `site/package.json`
- Create: `site/tsconfig.json`
- Create: `site/vite.config.ts`
- Create: `site/index.html`
- Create: `site/postcss.config.js`
- Create: `site/tailwind.config.ts`
- Create: `site/src/main.tsx`
- Create: `site/src/App.tsx`
- Create: `site/src/index.css`
- Create: `site/src/components/hero/workflow-demo.tsx`
- Create: `site/src/components/hero/hero-section.tsx`
- Create: `site/src/components/sections/how-it-works.tsx`
- Create: `site/src/components/sections/why-geeks-like-it.tsx`
- Create: `site/src/components/sections/quick-start.tsx`
- Create: `site/src/components/sections/final-cta.tsx`
- Create: `site/src/components/ui/section-shell.tsx`
- Create: `site/src/lib/content.ts`
- Create: `site/src/lib/workflow-steps.ts`
- Create: `site/src/assets/`

---

## Chunk 1: 站点骨架与构建配置

### Task 1: 创建前端工程基础文件

**Files:**
- Create: `site/package.json`
- Create: `site/tsconfig.json`
- Create: `site/vite.config.ts`
- Create: `site/index.html`
- Create: `site/postcss.config.js`
- Create: `site/tailwind.config.ts`

- [ ] **Step 1: 写出最小依赖清单**
  - 依赖包含：`react`、`react-dom`、`framer-motion`
  - 开发依赖包含：`vite`、`typescript`、`tailwindcss`、`postcss`、`autoprefixer`、`@types/react`、`@types/react-dom`

- [ ] **Step 2: 配置 TypeScript 与 Vite**
  - 设置 React + TS 构建入口
  - 站点根目录保持在 `site/`

- [ ] **Step 3: 配置 Tailwind**
  - 内容扫描仅覆盖 `site/index.html` 与 `site/src/**/*`
  - 扩展颜色、阴影、字体变量与动画令牌

- [ ] **Step 4: 安装依赖并验证开发服务器可启动**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm install && pnpm vite --host 127.0.0.1 --port 4173`
Expected: 本地开发服务器成功启动，无配置报错

### Task 2: 建立入口与全局样式

**Files:**
- Create: `site/src/main.tsx`
- Create: `site/src/App.tsx`
- Create: `site/src/index.css`

- [ ] **Step 1: 创建 React 入口**
  - 挂载 `App`
  - 导入全局样式

- [ ] **Step 2: 建立全局设计令牌**
  - 背景、文字、强调色、网格、噪点、选择文本色
  - 响应式容器与段落宽度规则

- [ ] **Step 3: 先搭出空白单页骨架**
  - 顶部导航
  - Hero 容器
  - 三个内容区块占位
  - 页脚占位

- [ ] **Step 4: 运行开发服务器检查首屏基础布局**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm vite --host 127.0.0.1 --port 4173`
Expected: 页面可访问，显示单页骨架与深色背景

---

## Chunk 2: 文案与区块组件

### Task 3: 固化页面内容数据

**Files:**
- Create: `site/src/lib/content.ts`
- Create: `site/src/components/ui/section-shell.tsx`

- [ ] **Step 1: 将首页文案结构化**
  - Hero 文案
  - How it works 四步
  - Why geeks like it 四点
  - Quick Start 命令与说明
  - Final CTA

- [ ] **Step 2: 写通用分区壳组件**
  - 统一标题、副标题、边距与分隔线

- [ ] **Step 3: 在 `App.tsx` 中接入内容数据与壳组件**

- [ ] **Step 4: 运行页面并检查排版节奏**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm vite --host 127.0.0.1 --port 4173`
Expected: 各区块文案已渲染，层级与留白正确

### Task 4: 实现 3 个内容区块

**Files:**
- Create: `site/src/components/sections/how-it-works.tsx`
- Create: `site/src/components/sections/why-geeks-like-it.tsx`
- Create: `site/src/components/sections/quick-start.tsx`
- Create: `site/src/components/sections/final-cta.tsx`
- Modify: `site/src/App.tsx`

- [ ] **Step 1: 实现 How it works 流程区**
  - 使用线性流程而不是卡片墙

- [ ] **Step 2: 实现 Why geeks like it 说明区**
  - 使用错位排版与低干扰视觉元素

- [ ] **Step 3: 实现 Quick Start 命令区**
  - 命令块真实可复制
  - 突出“快速开始”转化

- [ ] **Step 4: 实现 Final CTA**
  - 两个清晰按钮收尾

- [ ] **Step 5: 运行页面检查区块衔接**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm vite --host 127.0.0.1 --port 4173`
Expected: 除首屏外，整页内容结构完整

---

## Chunk 3: 首屏与工作流动画

### Task 5: 定义工作流步骤状态模型

**Files:**
- Create: `site/src/lib/workflow-steps.ts`

- [ ] **Step 1: 定义 4 到 5 个工作流阶段数据**
  - 本地终端启动
  - Discord 绑定完成
  - 主会话启动
  - 子代理并行执行
  - 历史归档完成

- [ ] **Step 2: 为每个阶段提供高亮目标与说明文案**

- [ ] **Step 3: 预留自动轮播与手动悬停的状态字段**

### Task 6: 实现 Hero 与交互动画面板

**Files:**
- Create: `site/src/components/hero/workflow-demo.tsx`
- Create: `site/src/components/hero/hero-section.tsx`
- Modify: `site/src/App.tsx`
- Modify: `site/src/index.css`

- [ ] **Step 1: 先写最小静态布局**
  - 左侧文案列
  - 右侧演示面板
  - 顶部轻导航

- [ ] **Step 2: 在演示面板中实现三大区域**
  - 本地终端
  - Discord 结构
  - 代理执行状态

- [ ] **Step 3: 加入自动播放逻辑**
  - 固定时间轮播各阶段
  - 用户悬停时暂停自动播放并切换高亮

- [ ] **Step 4: 使用 `framer-motion` 添加微动画**
  - 游标闪烁
  - 状态点脉冲
  - 连线 / 面板轻微浮动

- [ ] **Step 5: 在首屏中接入按钮与锚点跳转**

- [ ] **Step 6: 运行页面检查首屏是否足够强**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm vite --host 127.0.0.1 --port 4173`
Expected: 首屏可自动演示完整流程，悬停步骤时高亮与说明同步变化

---

## Chunk 4: 响应式、打磨与验证

### Task 7: 响应式适配与视觉打磨

**Files:**
- Modify: `site/src/components/hero/*.tsx`
- Modify: `site/src/components/sections/*.tsx`
- Modify: `site/src/index.css`

- [ ] **Step 1: 调整移动端 Hero 排列**
  - 文案在上，演示面板在下
  - 保持首屏完整可见

- [ ] **Step 2: 缩减小屏信息密度**
  - 精简次级标签
  - 保留核心流转关系

- [ ] **Step 3: 调整间距、字体、边框和发光强度**
  - 保持克制
  - 避免模板味和过度特效

- [ ] **Step 4: 验证滚动节奏与动效一致性**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm vite --host 127.0.0.1 --port 4173`
Expected: 桌面与移动端都具备清晰层级与稳定动效

### Task 8: 构建与最终验证

**Files:**
- Modify: `site/package.json`
- Modify: `site/src/**/*`（按需要）

- [ ] **Step 1: 增加 `dev`、`build`、`preview` 脚本**

- [ ] **Step 2: 执行生产构建**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm build`
Expected: 构建成功，无类型或打包报错

- [ ] **Step 3: 本地预览生产产物**

Run: `cd /Users/ld/Documents/github/agentcord/site && pnpm preview --host 127.0.0.1 --port 4174`
Expected: 生产预览可访问，首屏动画与区块内容正常

- [ ] **Step 4: 记录站点目录与运行方式**
  - 在最终交付中说明 `site/` 的启动和构建命令

