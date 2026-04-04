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
