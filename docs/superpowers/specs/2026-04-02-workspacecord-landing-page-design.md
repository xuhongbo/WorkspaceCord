# workspacecord 官网设计稿

**日期：** 2026-04-02
**目标目录：** `/Users/ld/Documents/github/agentcord/site`

## 目标

为 `workspacecord` 设计并实现一个未来感、极客终端感的产品官网，用来清晰演示其核心工作流：**本地终端 -> Discord -> 主代理 -> 子代理 -> 历史归档**。

官网的首要目标不是完整文档化所有能力，而是：

1. 让首次访问者一眼理解产品是什么。
2. 让目标用户感受到工作流的独特性与控制感。
3. 将用户转化到“快速开始”。

## 目标受众

优先受众为：**极客 / 效率工具用户**。

## 品牌与语气

- 品牌名：`workspacecord`
- 风格关键词：未来感、终端感、控制台、克制、清晰、可运行
- 避免：泛 SaaS 感、企业宣传腔、卡片堆砌、花哨特效

## 页面定位

官网应当被设计成一个**多智能体工作流发布页**，而不是普通营销页。

核心表达：

> 把本地终端和 Discord 连成一个多智能体开发控制台。

## 页面结构

### 1. Hero 首屏
- 品牌：`workspacecord`
- 主标题：把 Discord 变成你的多智能体开发控制台
- 副标题：把本地项目、主代理会话、子代理线程和历史归档，接进同一个运行中的工作流。
- 主按钮：快速开始
- 次按钮：查看 GitHub
- 主视觉：可交互工作流动画

### 2. How it works
- 挂载本地项目
- 启动主代理会话
- 派发子代理线程
- 归档历史记录

### 3. Why geeks like it
- Discord 原生结构
- 本地优先
- 天然多代理分层
- 默认可追踪与可归档

### 4. Quick Start
- `workspacecord config setup`
- `workspacecord project init --name my-project`
- `workspacecord`
- `/project setup project:my-project`

### 5. Final CTA
- 再次推动“快速开始”与 GitHub 访问。

## 首屏动画重构说明（2026-04-02 第二轮）

根据进一步确认，首屏动画不再采用“终端 / Discord / 代理 / 历史”并列高亮的方式，而改为**分镜式流程演示**，目标是让访问者明确理解两层结构：

1. **一个 Discord 服务器可以承载多个本地项目**
2. **单个项目内部会继续派生多个 session / thread**

### 新的分镜结构

#### 第一幕：本地终端挂载多个项目
终端中连续出现：
- `workspacecord project init --name alpha-api`
- `workspacecord project init --name design-system`
- `workspacecord project init --name agentcord`
- `workspacecord`

并显示已挂载多个项目的运行状态。

#### 第二幕：映射到 Discord 服务器
从终端动作之后逐步生成 Discord 结构：
- 一个服务器
- 多个项目分类
- 每个项目下至少出现 `#control` 和 `#history`

这一幕负责讲清“多个项目被映射进同一个 Discord 服务器”。

#### 第三幕：聚焦单个项目并展开 session
动画焦点收缩到 `agentcord` 项目分类，然后展开：
- 一个主会话
- 多个子线程 / 子代理
- 状态标签（运行中、等待、完成）

示例：
- `main: release prep`
- `sub: codex benchmark`
- `sub: claude fix auth`
- `sub: gemini docs sync`

这一幕负责讲清“单项目内部可以派生多个 session / thread”。

#### 第四幕：收束到历史归档
主会话与子线程结果逐渐汇入 `#history`，表现：
- 会话归档
- 历史可追踪
- 结果可回看

### 动画交互要求
- 默认自动播放完整一轮
- 顶部步骤切换应对应分镜：
  - 挂载项目
  - 映射到 Discord
  - 展开项目会话
  - 归档历史
- 用户悬停某一步时，动画停在该步骤并同步展示当前说明

### 视觉表达调整
- 强化从左到右的流动感与转场感
- 弱化并列小卡片感
- Discord 面板中明确体现多个项目的纵向结构
- 单项目内部再明确体现主会话 -> 子线程的层级关系
