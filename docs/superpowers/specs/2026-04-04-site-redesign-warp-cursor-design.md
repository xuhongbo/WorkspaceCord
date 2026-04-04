# workspacecord 官网设计稿 — Warp/Cursor 风格重构

**日期：** 2026-04-04
**设计方向：** Warp/Cursor — 生活方式与工具融合
**目标目录：** `/Users/ld/Documents/github/agentcord/site`

## 目标

将 workspacecord 官网从"功能展示型营销页"重构为"故事驱动型叙事页"，采用 Warp 和 Cursor 的设计语言：**暖调深灰背景 + 编辑感排版 + 工作流时间线**。

**核心叙事：远程协作枢纽。** 现有的 AI 编码工具（Claude Code、Codex）只能本地运行，无法远程协作，或者需要付费订阅。workspacecord 通过 Discord 提供一个**免费的远程编程工作台**：分类=项目，频道=session，一切井井有条。

## 视觉系统

### 色彩

| 角色 | 色值 | 说明 |
|------|------|------|
| 背景主色 | `#1c1b1a` | 暖调深灰，比纯黑有温度 |
| 背景次色 | `#242322` | 稍亮的表面色，用于卡片/容器 |
| 主文字 | `#f5f2ed` | 暖白，不是纯白 |
| 次要文字 | `#a8a4a0` | 暖灰色 |
| 强调色 | `#6ee7b7` | 翠绿，用于按钮/链接 |
| 强调色悬停 | `#a7f3d0` | 更亮的翠绿 |
| 边框色 | `rgba(214, 235, 253, 0.12)` | 冰蓝色半透明边框 |
| 代码背景 | `#141312` | 比背景更深的代码容器 |
| 状态绿 | `#22c55e` | 运行中/完成状态 |
| 状态蓝 | `#3b82f6` | 等待/处理中状态 |

### 字体

| 角色 | 字体 | 大小 | 字重 | 字间距 | 说明 |
|------|------|------|------|--------|------|
| 展示标题 | Inter | clamp(3rem, 5.6vw, 5.2rem) | 600 | -0.03em | 紧凑有力的英雄标题 |
| 区块标题 | Inter | 1.5rem–2rem | 600 | -0.02em | 章节标题 |
| 导航/标签 | Inter | 0.76rem | 500 | 0.16em | uppercase，宽字间距 |
| 正文 | Inter | 1rem–1.13rem | 400 | normal | 阅读舒适 |
| 代码 | `ui-monospace, SF Mono, Menlo` | 0.875rem | 400 | normal | 终端/代码块 |
| 小字 | Inter | 0.875rem | 400 | normal | 描述/辅助信息 |

### 组件样式

- **按钮**：圆角 9999px（pill 形），主按钮翠绿背景+深色文字，次按钮透明背景+冰蓝边框
- **卡片**：圆角 12px，暖灰背景 `#242322`，冰蓝半透明边框
- **代码块**：圆角 8px，更深背景 `#141312`，monospace 字体，左侧翠绿左边框
- **边框系统**：统一使用 `rgba(214, 235, 253, 0.12)` 冰蓝色半透明边框，不用传统阴影

## 页面结构（故事驱动）

### 第一幕：Hero — "远程编程，不该这么难"

**叙事：** 现有的 AI 编码工具只能本地运行。你想远程协作？要么付费订阅，要么放弃。workspacecord 用 Discord 给你一个免费的远程工作台。

**视觉：**
- 顶部导航栏：品牌 logo + 简洁导航（工作流、文档、GitHub）
- 左侧：大标题 + 副标题 + CTA
  - 标题：一行大字，直击痛点
  - 副标题：一句话解释价值主张 — Discord 做远程工作台，分类=项目，频道=session
  - CTA：`pnpm add -g workspacecord`（主按钮）+ GitHub（次按钮）
- 右侧：工作流动画（展示 Discord 服务器结构：分类→项目→频道→session）

**与当前区别：** 标题从"终端乱"改为"远程协作受限"，强调 Discord 作为远程工作台的独特价值。

### 第二幕：The Problem — "为什么你需要这个"

**叙事：** 三个远程协作的痛点，每个是一个"终端输出"风格的卡片。

**视觉：**
- 区块标题：uppercase 标签 "THE PROBLEM" + 正常标题
- 三栏卡片，每栏包含：
  - 一个 monospace 风格的 "终端片段"（展示问题）
  - 一行中文解释
- 背景从 `#1c1b1a` 微渐变到 `#1e1d1c`

**三个问题：**
1. `claude-code: local only` — "Claude Code 只能本地运行，无法远程协作"
2. `codex: subscription required` — "Codex 远程功能需要付费订阅"
3. `team: no shared workspace` — "没有统一的工作台，多人协作信息碎片化"

### 第零幕：Hero 动画 — "远程工作台的秩序感"

**叙事：** 展示 Discord 服务器如何成为一个有序的远程编程工作台。核心映射关系：**分类=项目，频道=session**。

**动画分镜（4 幕）：**

**第一幕：本地限制**
- 终端显示 `claude-code` 或 `codex` 运行中
- 提示 "local only" 或 "subscription required"
- 一个开发者在本地孤立地工作

**第二幕：Discord 工作台出现**
- 从终端动作过渡到 Discord 窗口
- 一个 Discord 服务器出现，命名为 "workspace-hub"
- 服务器结构开始建立

**第三幕：分类=项目，频道=session**
- 服务器中出现多个 Category（分类），每个对应一个项目
- 每个 Category 下出现频道：`#control`（主会话）、`#history`（归档）
- 选中一个项目（如 "api-gateway"），展开其频道
- 主会话频道中出现 session，session 下派生子线程
- 状态标签清晰：运行中、等待、完成

**第四幕：有序归档**
- 会话结果汇入 `#history`
- 全流程可追溯，团队任何人可查看
- Discord 作为远程协作中心的价值得到体现

**视觉表达调整：**
- 强化 Discord 服务器结构的展示（分类→项目→频道→session）
- 弱化终端窗口的比重，重点在 Discord 的有序结构
- 每个 Category 清晰对应一个项目
- 每个 Channel 清晰对应一个 session
- 动画整体传达"远程、工作台、有秩序"三个关键词

### 第三幕：The Workflow — "解决方案"

**叙事：** 时间线形式展示 workspacecord 如何解决远程协作问题。

**视觉：**
- 垂直时间线，左侧是一条翠绿竖线，右侧是 4 个节点
- 每个节点包含：
  - 步骤编号（monospace，翠绿圆圈）
  - 步骤标题（命令形式）
  - 简短描述

**四个步骤：**
1. `01` — `workspacecord project init` — 免费安装，无需订阅
2. `02` — `workspacecord start` — Discord 自动创建 Category=项目
3. `03` — 频道=session — 主会话 + 子线程，井井有条
4. `04` — `#history` — 全流程可追溯，团队共享

### 第四幕：Why Developers Love It — "场景证明"

**叙事：** 展示远程协作的具体场景，每个场景对应一个远程工作台的特性。

**视觉：**
- 2x2 卡片网格，每个卡片是一个场景故事
- 卡片格式：uppercase 场景标签 + 标题 + monospace "状态片段" + 解释

**四个场景：**
1. **REMOTE** — "不在办公室也能编程" — 展示从任何地方接入 Discord 工作台
2. **ORDER** — "分类=项目，频道=session" — Discord 服务器结构清晰映射
3. **FREE** — "开源免费，无需订阅" — 对比 Claude Code / Codex 的付费墙
4. **TRACE** — "全流程可追溯" — #history 中团队任何人可回看

### 第五幕：Quick Start — "三步开始"

**叙事：** 极简三步，强调免费和快速。

**视觉：**
- 居中的三步卡片，水平排列
- 每步：步骤编号（大号 monospace） + 命令 + 一行说明

**三步：**
```
01  pnpm add -g workspacecord     免费安装
02  workspacecord project init    创建项目
03  workspacecord start           开始远程协作
```

### 第六幕：Final CTA — "最后的推动"

- 一句话："Discord 就是你的远程编程工作台"
- 一个按钮：快速开始
- 底部 Footer：GitHub 链接 + 文档链接

## 与现有设计的关键差异

| 维度 | 当前设计 | 新设计 |
|------|---------|--------|
| 核心叙事 | "终端窗口太多" | "远程协作受限，Discord 是免费工作台" |
| Hero 标题 | "把 Discord 变成你的多智能体开发控制台" | "远程编程，不该这么难" |
| Problem 板块 | 个人终端混乱 | Claude Code 本地限制 / Codex 付费墙 / 无共享工作台 |
| 动画重点 | 终端→Discord→Session 的个人工作流 | Discord 服务器结构：分类=项目，频道=session |
| 场景卡片 | 个人效率场景 | 远程协作场景（REMOTE / ORDER / FREE / TRACE） |

## 响应式策略

- **Desktop（>1024px）**：完整布局，Hero 左右分栏
- **Tablet（768px–1024px）**：Hero 上下堆叠，时间线左侧移到顶部
- **Mobile（<768px）**：单列，时间线简化为垂直列表，代码块水平滚动
