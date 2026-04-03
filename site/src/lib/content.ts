export const heroContent = {
  eyebrow: 'workspacecord',
  title: '把 Discord 变成你的多智能体开发控制台',
  description:
    '把本地项目、主代理会话、子代理线程和历史归档，接进同一个运行中的工作流。',
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

export const howItWorksSteps = [
  {
    id: 'mount',
    title: '挂载本地项目',
    body: '在本地终端运行初始化命令，把真实工程绑定到 Discord 服务器。',
  },
  {
    id: 'spawn',
    title: '启动主代理会话',
    body: '从控制频道创建主会话，让每个任务都有清晰入口和上下文。',
  },
  {
    id: 'dispatch',
    title: '派发子代理线程',
    body: '在主会话下并行展开分析、修复、验证等子任务。',
  },
  {
    id: 'archive',
    title: '归档执行历史',
    body: '把结果收进 #history，方便回看、追踪与复盘。',
  },
] as const;

export const reasons = [
  {
    title: 'Discord Native',
    body: '直接使用频道、线程和归档这些原生结构，不需要重新学习一套系统。',
  },
  {
    title: 'Local-first',
    body: '绑定的是你自己的本地项目，命令、文件和上下文都在你的机器上完成。',
  },
  {
    title: 'Multi-agent by Design',
    body: '主代理与子代理天然分层，适合拆任务、并行推进和集中调度。',
  },
  {
    title: 'Traceable by Default',
    body: '从启动到归档，全流程可追踪，不再丢失会话上下文和执行历史。',
  },
] as const;

export const quickStartSteps = [
  {
    title: '配置全局凭据',
    command: 'workspacecord config setup',
  },
  {
    title: '挂载本地项目',
    command: 'workspacecord project init --name my-project',
  },
  {
    title: '启动服务',
    command: 'workspacecord',
  },
  {
    title: '绑定 Discord 频道',
    command: '/project setup project:my-project',
  },
] as const;

export const finalCta = {
  title: '现在，把 Discord 变成你的多智能体工作台。',
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
