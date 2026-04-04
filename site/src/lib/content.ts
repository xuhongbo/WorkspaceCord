export const heroContent = {
  eyebrow: 'workspacecord',
  title: '远程编程，不该这么难',
  description:
    'Claude Code 只能本地，Codex 远程要订阅。workspacecord 用 Discord 给你一个免费的远程编程工作台——分类=项目，频道=session，一切井井有条。支持 Claude Code 与 OpenAI Codex 双引擎，子线程并发，全流程可追溯。',
  primaryCta: {
    label: '快速开始',
    href: '#quick-start',
  },
  secondaryCta: {
    label: '查看 GitHub',
    href: 'https://github.com/xuhongbo/WorkspaceCord',
  },
  stats: ['免费开源', '双引擎支持', 'Discord 原生'],
} as const;

export const problemCards = [
  {
    terminal: 'claude-code: local only — remote access not available',
    body: 'Claude Code 只能本地运行，无法远程协作',
  },
  {
    terminal: 'codex: remote sessions require paid subscription',
    body: 'Codex 的远程功能需要付费订阅',
  },
  {
    terminal: 'team: no shared workspace for AI agents',
    body: '没有统一工作台，多人协作信息碎片化',
  },
] as const;

export const howItWorksSteps = [
  {
    id: 'install',
    title: 'pnpm add -g workspacecord',
    body: '免费安装，无需订阅。CLI 接入 Claude Code 与 Codex 双引擎。',
  },
  {
    id: 'project',
    title: 'workspacecord project init',
    body: '创建项目并绑定 Discord 服务器，分类=项目，频道=session。',
  },
  {
    id: 'start',
    title: 'workspacecord start',
    body: '启动后 Discord 自动创建 Category 结构，一切就绪。',
  },
  {
    id: 'session',
    title: '/agent spawn → 频道=session',
    body: '主会话 + 子线程（/subagent run），并发执行，全流程可追溯。',
  },
] as const;

export const developerScenes = [
  {
    tag: 'REMOTE',
    title: '不在办公室也能编程',
    terminal: 'anywhere → discord → workspace',
    body: '从任何地方接入 Discord 工作台，远程协作无边界。',
  },
  {
    tag: 'ORDER',
    title: '分类=项目，频道=session',
    terminal: 'category / api-gateway → #control #history',
    body: 'Discord 服务器结构清晰映射项目与会话，一目了然。',
  },
  {
    tag: 'FREE',
    title: '开源免费，双引擎支持',
    terminal: 'Claude Code + Codex — free forever',
    body: '对比付费墙，完全免费开源，支持两大 AI 编码引擎。',
  },
  {
    tag: 'TRACE',
    title: '全流程可追溯',
    terminal: '#history: session → complete → archived',
    body: '每个 session 的结果自动归档，#history 频道随时回看。',
  },
] as const;

export const quickStartSteps = [
  {
    step: '01',
    command: 'pnpm add -g workspacecord',
    label: '免费安装',
  },
  {
    step: '02',
    command: 'workspacecord project init',
    label: '创建项目',
  },
  {
    step: '03',
    command: 'workspacecord start',
    label: 'Discord 开始协作',
  },
] as const;

export const finalCta = {
  title: 'Discord 就是你的远程编程工作台',
  description: '免费、开源、有序。一个服务器，多个项目，全部在控。',
  primary: {
    label: '快速开始',
    href: '#quick-start',
  },
  secondary: {
    label: '前往 GitHub',
    href: 'https://github.com/xuhongbo/WorkspaceCord',
  },
} as const;
