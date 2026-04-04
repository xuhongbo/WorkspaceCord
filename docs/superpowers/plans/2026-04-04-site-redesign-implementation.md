# 站点重构 — Warp/Cursor 风格实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 workspacecord 官网从"功能展示型营销页"重构为"故事驱动型叙事页"，采用 Warp/Cursor 设计语言。

**Architecture:** 通过重写 CSS 变量系统和关键组件样式来实现视觉转换，同时调整页面结构和文案以支持故事驱动的叙事（Problem → Workflow → Scenes → Quick Start）。保留现有 React 组件架构和 WorkflowDemo 动画。

**Tech Stack:** Vite + React 19 + Tailwind CSS 3 + framer-motion + TypeScript

---

### Task 1: 设计系统 — CSS 变量与全局样式

**Files:**
- Modify: `site/src/index.css`

核心变更：
- 背景从 `#06070b` 移到 `#1c1b1a`（暖调深灰）
- 去掉网格线装饰和噪点（`body::before` 和 `.page-noise`）
- 去掉 Hero 区域的渐变光晕
- 强调色从紫色移到翠绿 `#6ee7b7`
- 边框从紫灰色移到冰蓝色 `rgba(214, 235, 253, 0.12)`

```css
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    'Segoe UI', sans-serif;
  background: #1c1b1a;
  color: #f5f2ed;
}

/* 去掉 body::before 网格线和 .page-noise */
```

**按钮变更：**
- 主按钮：翠绿背景 `#6ee7b7` + 深色文字 `#1a1a1a`
- 次按钮：透明背景 + 冰蓝边框 `rgba(214, 235, 253, 0.25)`

**卡片容器：**
- `.section-shell` / `.final-cta` 背景改为 `#242322`
- 边框改为 `rgba(214, 235, 253, 0.12)`

- [ ] **Step 1: 修改 index.css 的 :root、body、按钮和卡片样式**

```css
/* index.css — 替换 :root 区域 */
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
    'Segoe UI', sans-serif;
  background: #1c1b1a;
  color: #f5f2ed;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  min-width: 320px;
  background: transparent;
  color: #f5f2ed;
}

/* 删除 body::before 网格线装饰 */

a {
  color: inherit;
  text-decoration: none;
}

button,
input,
textarea,
select {
  font: inherit;
}
```

- [ ] **Step 2: 删除 `.page-noise` 样式规则**

```css
/* 删除整个 .page-noise 块 */
```

- [ ] **Step 3: 更新按钮样式**

```css
.button-primary {
  background: #6ee7b7;
  color: #1a1a1a;
  box-shadow: 0 16px 48px rgba(110, 231, 183, 0.2);
}

.button-primary:hover {
  background: #a7f3d0;
}

.button-secondary {
  border: 1px solid rgba(214, 235, 253, 0.25);
  background: transparent;
  color: #f5f2ed;
}
```

- [ ] **Step 4: 更新卡片容器样式**

```css
.section-shell,
.final-cta {
  background: #242322;
  border: 1px solid rgba(214, 235, 253, 0.12);
}
```

- [ ] **Step 5: 运行 `pnpm typecheck && pnpm build` 验证**

```bash
cd /Users/ld/Documents/github/agentcord/site
pnpm typecheck
pnpm build
```
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add site/src/index.css
git commit -m "style: switch to warm gray design system with emerald accent"
```

---

### Task 2: Hero Section — 内容重构

**Files:**
- Modify: `site/src/App.tsx`
- Modify: `site/src/components/hero/hero-section.tsx`
- Modify: `site/src/lib/content.ts`
- Modify: `site/src/index.css`

Hero 调整：
- 标题改为更紧凑的 monospace 风格
- 保留 WorkflowDemo 但缩小比例
- 导航栏改为简洁样式（uppercase 标签 + 宽字间距）

- [ ] **Step 1: 更新 content.ts 的 heroContent**

```typescript
export const heroContent = {
  eyebrow: 'workspacecord',
  title: '你的终端，不该这么乱',
  description:
    '把本地项目、AI 代理会话和 Discord 频道接进同一个运行中的工作流。',
  primaryCta: {
    label: '快速开始',
    href: '#quick-start',
  },
  secondaryCta: {
    label: '查看 GitHub',
    href: 'https://github.com/xuhongbo/WorkspaceCord',
  },
  stats: ['本地优先', '多代理调度', 'Discord 原生结构'],
} as const;
```

- [ ] **Step 2: 更新 hero-section.tsx 的布局**

```tsx
// hero-section.tsx — 简化布局，去掉多余的 supporting 文本
<div className="hero-copy">
  <p className="hero-eyebrow">
    本地终端启动 → 收进 Dock → 拉起 Discord → 展开线程 → 收束 #history
  </p>
  <h1>{heroContent.title}</h1>
  <p className="hero-description">{heroContent.description}</p>
  <div className="cta-group">
    <a className="button button-primary" href={heroContent.primaryCta.href}>
      {heroContent.primaryCta.label}
    </a>
    <a
      className="button button-secondary"
      href={heroContent.secondaryCta.href}
      target="_blank"
      rel="noreferrer"
    >
      {heroContent.secondaryCta.label}
    </a>
  </div>
  <ul className="hero-stats">
    {heroContent.stats.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
</div>
```

- [ ] **Step 3: 更新 App.tsx，调整页面结构顺序**

```tsx
export default function App() {
  return (
    <div id="top" className="page-shell">
      <HeroSection />
      <main>
        <TheProblemSection />
        <HowItWorksSection />
        <WhyDevelopersLoveItSection />
        <QuickStartSection />
        <FinalCtaSection />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 更新 CSS 中的 hero 样式**

```css
/* index.css — hero 标题更紧凑 */
.hero-copy h1 {
  margin: 0;
  font-size: clamp(2.4rem, 4.8vw, 4rem);
  line-height: 1.05;
  letter-spacing: -0.04em;
  text-wrap: balance;
}

.hero-description {
  color: #a8a4a0;
}

/* 去掉 hero 区域的渐变光晕 */
```

- [ ] **Step 5: 提交**

```bash
git add site/src/App.tsx site/src/components/hero/hero-section.tsx site/src/lib/content.ts site/src/index.css
git commit -m "feat: restructure hero section with problem-first narrative"
```

---

### Task 3: The Problem Section — 新增板块

**Files:**
- Create: `site/src/components/sections/the-problem.tsx`
- Modify: `site/src/lib/content.ts`
- Modify: `site/src/index.css`

新增"问题"板块，展示三个终端输出风格的问题卡片。

- [ ] **Step 1: 在 content.ts 中添加问题数据**

```typescript
export const problemCards = [
  {
    terminal: 'terminal: session-1 | session-2 | session-3 | session-4 | session-5',
    body: '5 个 session，5 个终端窗口来回切换',
  },
  {
    terminal: 'discord: 37 unread messages in #general',
    body: '有用的对话淹没在噪音中',
  },
  {
    terminal: 'git: where did that fix come from?',
    body: '无法追踪谁做了什么、改了哪里',
  },
] as const;
```

- [ ] **Step 2: 创建 the-problem.tsx 组件**

```tsx
import { problemCards } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function TheProblemSection() {
  return (
    <SectionShell
      id="the-problem"
      eyebrow="The Problem"
      title="你的一天是这样的"
      description="终端塞满窗口，Discord 消息乱飞，上下文在切换中丢失。"
    >
      <div className="problem-grid">
        {problemCards.map((card) => (
          <article key={card.terminal} className="problem-card">
            <code>{card.terminal}</code>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
```

- [ ] **Step 3: 添加 CSS 样式**

```css
.problem-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.problem-card {
  padding: 24px;
  border-radius: 12px;
  background: #141312;
  border: 1px solid rgba(214, 235, 253, 0.12);
}

.problem-card code {
  display: block;
  font-family: 'SFMono-Regular', 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 0.875rem;
  color: #6ee7b7;
  margin-bottom: 12px;
  white-space: nowrap;
  overflow-x: auto;
}

.problem-card p {
  margin: 0;
  color: #a8a4a0;
  font-size: 1rem;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .problem-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: 提交**

```bash
git add site/src/components/sections/the-problem.tsx site/src/lib/content.ts site/src/index.css
git commit -m "feat: add problem section with terminal-output style cards"
```

---

### Task 4: How It Works → 时间线样式

**Files:**
- Modify: `site/src/components/sections/how-it-works.tsx`
- Modify: `site/src/lib/content.ts`
- Modify: `site/src/index.css`

将原有的 4 列网格改为垂直时间线。

- [ ] **Step 1: 更新 content.ts 的工作流步骤**

```typescript
export const howItWorksSteps = [
  {
    id: 'mount',
    title: 'workspacecord project init',
    body: '挂载项目到全局配置，绑定本地工程到 Discord 服务器。',
  },
  {
    id: 'start',
    title: 'workspacecord start',
    body: '启动后台守护进程，Discord 自动创建 Category 结构。',
  },
  {
    id: 'session',
    title: '/session start',
    body: '展开 Session 线程，主代理规划，子代理执行。',
  },
  {
    id: 'archive',
    title: '#history',
    body: '会话自动归档到历史频道，全流程可追溯。',
  },
] as const;
```

- [ ] **Step 2: 重写 how-it-works.tsx 为垂直时间线**

```tsx
import { howItWorksSteps } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function HowItWorksSection() {
  return (
    <SectionShell
      id="workflow"
      eyebrow="The Workflow"
      title="解决方案"
      description="从终端到 Discord，一条工作流串联所有步骤。"
    >
      <div className="workflow-timeline-v2">
        {howItWorksSteps.map((step, index) => (
          <div key={step.id} className="timeline-item">
            <div className="timeline-marker">
              <span className="timeline-marker-index">0{index + 1}</span>
            </div>
            <div className="timeline-content">
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
```

- [ ] **Step 3: 添加时间线 CSS**

```css
.workflow-timeline-v2 {
  display: grid;
  gap: 0;
  position: relative;
  padding-left: 32px;
}

.workflow-timeline-v2::before {
  content: '';
  position: absolute;
  left: 15px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #6ee7b7;
  border-radius: 1px;
}

.timeline-item {
  position: relative;
  padding-bottom: 32px;
}

.timeline-item:last-child {
  padding-bottom: 0;
}

.timeline-marker {
  position: absolute;
  left: -32px;
  top: 0;
}

.timeline-marker-index {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: #6ee7b7;
  color: #1a1a1a;
  font-size: 0.75rem;
  font-weight: 700;
  font-family: 'SFMono-Regular', 'JetBrains Mono', monospace;
}

.timeline-content h3 {
  margin: 0 0 8px;
  font-size: 1.1rem;
  letter-spacing: -0.02em;
  font-family: 'SFMono-Regular', 'JetBrains Mono', monospace;
  color: #f5f2ed;
}

.timeline-content p {
  margin: 0;
  color: #a8a4a0;
  font-size: 1rem;
  line-height: 1.6;
}
```

- [ ] **Step 4: 删除旧的 .flow-grid 和 .flow-step 样式**

```css
/* 删除 .flow-grid, .flow-step, .flow-index, .flow-line 相关样式 */
```

- [ ] **Step 5: 提交**

```bash
git add site/src/components/sections/how-it-works.tsx site/src/lib/content.ts site/src/index.css
git commit -m "feat: convert how-it-works to vertical timeline style"
```

---

### Task 5: Why Developers Love It → 场景卡片

**Files:**
- Modify: `site/src/components/sections/why-geeks-like-it.tsx`
- Modify: `site/src/lib/content.ts`
- Modify: `site/src/index.css`

将"为什么喜欢"改为 2x2 场景卡片，每个卡片是一个"开发者的一天"中的具体场景。

- [ ] **Step 1: 更新 content.ts**

```typescript
export const developerScenes = [
  {
    tag: 'FOCUS',
    title: '收进 Dock，不再切窗口',
    terminal: '5 terminal windows → 1 Discord channel',
    body: '所有 session 统一进入 Discord 频道，不再在终端窗口间来回切换。',
  },
  {
    tag: 'PARALLEL',
    title: '同时推进 3 条线',
    terminal: 'main: planning → sub-1: coding → sub-2: docs',
    body: '主代理规划方向，子代理并行执行，互不阻塞。',
  },
  {
    tag: 'TRACK',
    title: '谁改了什么，一清二楚',
    terminal: '#history: auth-rollout → summary posted',
    body: '每个 session 的结果自动归档到 #history，可随时回看。',
  },
  {
    tag: 'TEAM',
    title: '队友加入只需一个命令',
    terminal: 'workspacecord project init --name my-project',
    body: '项目配置共享，新成员一条命令就能接入完整工作流。',
  },
] as const;
```

- [ ] **Step 2: 重写 why-geeks-like-it.tsx**

```tsx
import { developerScenes } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function WhyDevelopersLoveItSection() {
  return (
    <SectionShell
      eyebrow="Why Developers Love It"
      title="场景证明"
      description="不是罗列功能，而是看看开发者的一天。"
    >
      <div className="scenes-grid">
        {developerScenes.map((scene) => (
          <article key={scene.tag} className="scene-card">
            <span className="scene-tag">{scene.tag}</span>
            <h3>{scene.title}</h3>
            <code>{scene.terminal}</code>
            <p>{scene.body}</p>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
```

- [ ] **Step 3: 添加场景卡片 CSS**

```css
.scenes-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.scene-card {
  padding: 24px;
  border-radius: 12px;
  background: #242322;
  border: 1px solid rgba(214, 235, 253, 0.12);
  display: grid;
  gap: 8px;
}

.scene-tag {
  font-size: 0.72rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #6ee7b7;
  font-weight: 500;
}

.scene-card h3 {
  margin: 0;
  font-size: 1.15rem;
  letter-spacing: -0.02em;
}

.scene-card code {
  font-family: 'SFMono-Regular', 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 0.8rem;
  color: #6ee7b7;
  padding: 8px 12px;
  border-radius: 8px;
  background: #141312;
  border-left: 2px solid #6ee7b7;
  display: inline-block;
}

.scene-card p {
  margin: 0;
  color: #a8a4a0;
  font-size: 0.95rem;
  line-height: 1.6;
}

@media (max-width: 760px) {
  .scenes-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 4: 删除旧的 .reasons-grid 和 .reason-item 样式**

```css
/* 删除 .reasons-grid, .reason-item, .reason-item[data-offset='end'] 相关样式 */
```

- [ ] **Step 5: 提交**

```bash
git add site/src/components/sections/why-geeks-like-it.tsx site/src/lib/content.ts site/src/index.css
git commit -m "feat: convert reasons section to 2x2 developer scene cards"
```

---

### Task 6: Quick Start — 简化为三步

**Files:**
- Modify: `site/src/components/sections/quick-start.tsx`
- Modify: `site/src/lib/content.ts`
- Modify: `site/src/index.css`

- [ ] **Step 1: 更新 content.ts**

```typescript
export const quickStartSteps = [
  {
    step: '01',
    command: 'pnpm add -g workspacecord',
    label: '安装',
  },
  {
    step: '02',
    command: 'workspacecord project init',
    label: '挂载项目',
  },
  {
    step: '03',
    command: 'workspacecord start',
    label: '开始工作',
  },
] as const;
```

- [ ] **Step 2: 重写 quick-start.tsx**

```tsx
import { quickStartSteps } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function QuickStartSection() {
  return (
    <SectionShell
      id="quick-start"
      eyebrow="Quick Start"
      title="三步开始"
      description="安装、挂载、启动。然后回到 Discord，开始工作。"
    >
      <div className="quickstart-steps">
        {quickStartSteps.map((step) => (
          <div key={step.step} className="quickstart-step">
            <span className="quickstart-step-number">{step.step}</span>
            <code>{step.command}</code>
            <span className="quickstart-step-label">{step.label}</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
```

- [ ] **Step 3: 更新 CSS**

```css
.quickstart-steps {
  display: flex;
  gap: 24px;
  justify-content: center;
}

.quickstart-step {
  display: grid;
  gap: 12px;
  text-align: center;
  padding: 24px;
  border-radius: 12px;
  background: #242322;
  border: 1px solid rgba(214, 235, 253, 0.12);
  min-width: 200px;
}

.quickstart-step-number {
  font-family: 'SFMono-Regular', 'JetBrains Mono', monospace;
  font-size: 2rem;
  font-weight: 700;
  color: #6ee7b7;
}

.quickstart-step code {
  font-family: 'SFMono-Regular', 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 0.875rem;
  color: #f5f2ed;
  padding: 8px 16px;
  border-radius: 8px;
  background: #141312;
  border-left: 2px solid #6ee7b7;
}

.quickstart-step-label {
  color: #a8a4a0;
  font-size: 0.9rem;
}

@media (max-width: 760px) {
  .quickstart-steps {
    flex-direction: column;
    align-items: center;
  }
}
```

- [ ] **Step 4: 删除旧的 .quickstart-panel, .quickstart-row, .quickstart-meta 样式**

```css
/* 删除旧的 quickstart 相关样式 */
```

- [ ] **Step 5: 提交**

```bash
git add site/src/components/sections/quick-start.tsx site/src/lib/content.ts site/src/index.css
git commit -m "feat: simplify quick start to 3 horizontal steps"
```

---

### Task 7: Final CTA & 全局排版微调

**Files:**
- Modify: `site/src/components/sections/final-cta.tsx`
- Modify: `site/src/lib/content.ts`
- Modify: `site/src/index.css`

- [ ] **Step 1: 更新 content.ts**

```typescript
export const finalCta = {
  title: '把 Discord 变成你的多智能体开发控制台',
  description: '一个服务器，多个代理，全部在控。',
  primary: {
    label: '快速开始',
    href: '#quick-start',
  },
  secondary: {
    label: '前往 GitHub',
    href: 'https://github.com/xuhongbo/WorkspaceCord',
  },
} as const;
```

- [ ] **Step 2: 简化 final-cta.tsx**

```tsx
import { finalCta } from '../../lib/content';

export function FinalCtaSection() {
  return (
    <section className="final-cta">
      <div>
        <p className="section-eyebrow">Ready to run</p>
        <h2>{finalCta.title}</h2>
        <p>{finalCta.description}</p>
      </div>
      <a className="button button-primary" href={finalCta.primary.href}>
        {finalCta.primary.label}
      </a>
    </section>
  );
}
```

- [ ] **Step 3: 全局排版微调 — uppercase 标签 + 宽字间距**

```css
/* index.css — 在现有 .section-eyebrow 基础上 */
.section-eyebrow {
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
  color: #6ee7b7;
  font-weight: 500;
}

/* 去掉旧的 purple gradient 时间线 */
.workflow-timeline-line {
  display: none;
}

/* 去掉 hero 区域的额外光晕 */
.desktop-glow {
  display: none;
}
```

- [ ] **Step 4: 更新 topbar 导航样式**

```css
.topbar nav {
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 0.8rem;
  color: #a8a4a0;
}

.topbar nav a:hover {
  color: #6ee7b7;
}
```

- [ ] **Step 5: 提交**

```bash
git add site/src/components/sections/final-cta.tsx site/src/lib/content.ts site/src/index.css
git commit -m "feat: finalize CTA and global typography polish"
```

---

### Task 8: 验证与清理

**Files:**
- Modify: `site/src/index.css` (cleanup unused styles)
- Verify: all tests pass

- [ ] **Step 1: 清理未使用的 CSS 样式**

需要删除的旧样式：
- `.flow-grid`, `.flow-step`, `.flow-index`, `.flow-line`
- `.reasons-grid`, `.reason-item`, `.reason-item[data-offset='end']`
- `.quickstart-panel`, `.quickstart-row`, `.quickstart-meta`, `.quickstart-index`
- `.desktop-glow`, `.desktop-glow-left`, `.desktop-glow-right`
- `.workflow-timeline-line` (旧的紫色渐变线)
- `.workflow-lane`, `.lane-block`, `.lane-connector` (如果不再使用)
- `.final-cta` 的旧 flex 布局（如果改为简化版）

- [ ] **Step 2: 运行完整测试**

```bash
cd /Users/ld/Documents/github/agentcord/site
pnpm typecheck
pnpm test
pnpm build
```
Expected: ALL PASS

- [ ] **Step 3: 提交清理**

```bash
git add site/src/index.css
git commit -m "style: remove unused CSS from previous design"
```
