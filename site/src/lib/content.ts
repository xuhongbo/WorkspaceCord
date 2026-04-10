export const heroContent = {
  eyebrow: 'MULTI-PROJECT × MULTI-SESSION × REMOTE',
  titleLine1: '一个 Discord 服务器，',
  titleLine2: '装下你所有 AI 编码任务。',
  description:
    'Claude Code + Codex 双引擎。项目对应分类，会话对应频道，子任务对应线程。多项目并行、多 session 并行，从任何地方远程指挥——Discord 天生就是管这个的。',
  install: 'pnpm i -g workspacecord',
  primaryCta: {
    label: '一分钟跑起来',
    href: '#quick-start',
  },
  secondaryCta: {
    label: 'GitHub',
    href: 'https://github.com/xuhongbo/WorkspaceCord',
  },
  badges: ['Claude Code', 'OpenAI Codex', '多项目并行', '免费开源'],
} as const;

export const problemContent = {
  eyebrow: 'THE GAP',
  title: '想远程用 AI 编程？要么掏钱，要么没得选。',
  description: '两大引擎的远程能力各有硬伤，workspacecord 用 Discord 把它们都接了出来。',
  compareCards: [
    {
      brand: 'Claude Code',
      verdict: '能远程，但要付钱',
      pain: 'Remote 锁在付费订阅后面',
      detail: '官方 Claude Code remote 需要 Claude 的付费订阅，每月一笔额外开销。本地版是免费的，但出门就用不了。',
      tone: 'warm',
    },
    {
      brand: 'OpenAI Codex',
      verdict: '压根没有远程',
      pain: '官方没提供 remote 这个选项',
      detail: 'Codex 只有本地 CLI。想在手机上、在外面操控？官方根本不做这事。',
      tone: 'cool',
    },
  ],
  bridge: {
    brand: 'workspacecord',
    headline: '两个都给你免费远程，接到 Discord 上。',
    detail:
      '本机继续跑 Claude Code 和 Codex，Discord 当远程终端——你在哪都能发 prompt，实时看日志，点按钮批准。不用订阅，不用换账号。',
  },
} as const;

export type OneServerMessageKind =
  | 'user'
  | 'agent-thinking'
  | 'agent-tool'
  | 'agent-ok'
  | 'agent-warn'
  | 'agent-card';

export type AgentCardField = {
  key: string;
  value: string;
  accent?: 'claude' | 'codex' | 'neutral';
};

export type OneServerMessage = {
  author: string;
  kind: OneServerMessageKind;
  text?: string;
  card?: {
    title: string;
    provider: 'Claude' | 'OpenAI Codex';
    fields: AgentCardField[];
    linkChannel: string;
  };
};

export type OneServerScene = {
  id: string;
  activeCategoryId: string;
  activeChannelId: string;
  channelTitle: string;
  subtitle: string;
  isControl?: boolean;
  welcomeBanner?: {
    channelName: string;
    provider: string;
    description: string;
  };
  messages: OneServerMessage[];
  approval?: { title: string };
  footer?: string;
};

export const oneServerContent = {
  eyebrow: 'ONE SERVER, EVERYTHING',
  title: '一个服务器，装下所有项目和 session。',
  description:
    '同一个 Discord 服务器，3 个项目并行跑着 9 个 session。不用开 IDE，不用 SSH，不用切 workspace——打开 Discord 就能在任何一个 session 里干活。下面演示的是真实用法。',
  serverName: 'coding',
  categories: [
    {
      id: 'agentcord',
      name: 'agentcord',
      description: '主项目：多 agent 编排引擎',
      channels: [
        { id: 'ac-control', name: 'control', tone: 'control' as const },
        { id: 'ac-fix', name: 'claude-fix-auth-bug', tone: 'claude' as const, status: 'running' as const },
        { id: 'ac-refactor', name: 'claude-refactor-payment', tone: 'claude' as const, status: 'streaming' as const },
        { id: 'ac-codex-test', name: 'codex-test', tone: 'codex' as const, status: 'awaiting' as const },
        { id: 'ac-history', name: 'history', tone: 'forum' as const, count: 40 },
      ],
    },
    {
      id: 'threadcord',
      name: 'threadcord-项目',
      description: '老项目：Discord thread 管理工具',
      channels: [
        { id: 'tc-control', name: 'control', tone: 'control' as const },
        { id: 'tc-src', name: 'claude-src-refactor', tone: 'claude' as const, status: 'running' as const },
        { id: 'tc-codex', name: 'codex-perf-benchmark', tone: 'codex' as const, status: 'running' as const },
        { id: 'tc-history', name: 'history', tone: 'forum' as const, count: 17 },
      ],
    },
    {
      id: 'site',
      name: 'site-redesign',
      description: '临时项目：官网改版',
      channels: [
        { id: 's-control', name: 'control', tone: 'control' as const },
        { id: 's-hero', name: 'claude-hero-copy', tone: 'claude' as const, status: 'streaming' as const },
        { id: 's-bento', name: 'claude-bento-layout', tone: 'claude' as const, status: 'running' as const },
        { id: 's-history', name: 'history', tone: 'forum' as const, count: 4 },
      ],
    },
  ],
  scenes: [
    {
      id: 'spawn-agentcord',
      activeCategoryId: 'agentcord',
      activeChannelId: 'ac-control',
      channelTitle: 'control',
      subtitle: 'Use /agent spawn here to create new agent sessions',
      isControl: true,
      messages: [
        { author: '你', kind: 'user', text: '/agent spawn label:fix-auth-bug' },
        {
          author: 'workspacecord · bot',
          kind: 'agent-card',
          card: {
            title: 'Agent Created: fix-auth-bug',
            provider: 'Claude',
            linkChannel: '#claude-fix-auth-bug',
            fields: [
              { key: 'Channel', value: '#claude-fix-auth-bug', accent: 'claude' },
              { key: 'Provider', value: 'Claude', accent: 'claude' },
              { key: 'Mode', value: 'auto — full autonomy' },
              { key: 'Directory', value: '~/projects/agentcord' },
            ],
          },
        },
      ],
      footer: '一条 /agent spawn，Discord 里就多出一个 session 频道。',
    },
    {
      id: 'use-agentcord',
      activeCategoryId: 'agentcord',
      activeChannelId: 'ac-fix',
      channelTitle: 'claude-fix-auth-bug',
      subtitle: 'claude · session running',
      welcomeBanner: {
        channelName: 'claude-fix-auth-bug',
        provider: 'Claude',
        description: 'fix-auth-bug · auto mode · sandbox: workspace-write',
      },
      messages: [
        { author: '你', kind: 'user', text: '帮我修下 auth 中间件的 401 bug' },
        { author: 'workspacecord · bot', kind: 'agent-thinking', text: '🧠 reading src/auth.ts · src/middleware.ts' },
        { author: 'workspacecord · bot', kind: 'agent-tool', text: '🔧 editing src/middleware.ts (+18 -4)' },
        { author: 'workspacecord · bot', kind: 'agent-tool', text: '🔧 running npm test' },
        { author: 'workspacecord · bot', kind: 'agent-ok', text: '✓ 3 tests passed · ready to commit' },
      ],
      footer: '点进新频道就开始干活，发消息就是 prompt。',
    },
    {
      id: 'spawn-threadcord',
      activeCategoryId: 'threadcord',
      activeChannelId: 'tc-control',
      channelTitle: 'control',
      subtitle: 'Use /agent spawn here to create new agent sessions',
      isControl: true,
      messages: [
        { author: '你', kind: 'user', text: '/agent spawn label:perf-benchmark provider:codex' },
        {
          author: 'workspacecord · bot',
          kind: 'agent-card',
          card: {
            title: 'Agent Created: perf-benchmark',
            provider: 'OpenAI Codex',
            linkChannel: '#codex-perf-benchmark',
            fields: [
              { key: 'Channel', value: '#codex-perf-benchmark', accent: 'codex' },
              { key: 'Provider', value: 'OpenAI Codex', accent: 'codex' },
              { key: 'Mode', value: 'auto — full autonomy' },
              { key: 'Directory', value: '~/projects/threadcord' },
              { key: 'Sandbox', value: 'workspace-write · approval=never · network=on' },
            ],
          },
        },
      ],
      footer: '另一个项目、另一个引擎，同一个工作流。',
    },
    {
      id: 'use-threadcord',
      activeCategoryId: 'threadcord',
      activeChannelId: 'tc-codex',
      channelTitle: 'codex-perf-benchmark',
      subtitle: 'codex · streaming',
      welcomeBanner: {
        channelName: 'codex-perf-benchmark',
        provider: 'OpenAI Codex',
        description: 'perf-benchmark · auto mode · workspace-write',
      },
      messages: [
        { author: '你', kind: 'user', text: '跑一下 src/server.ts 的 p95 延迟基准，给前后对比' },
        { author: 'workspacecord · bot', kind: 'agent-tool', text: '🔧 codex running benchmark harness' },
        { author: 'workspacecord · bot', kind: 'agent-tool', text: '🔧 profiling hot paths · 30s warmup' },
        { author: 'workspacecord · bot', kind: 'agent-thinking', text: '🧠 extracting flame graph' },
        { author: 'workspacecord · bot', kind: 'agent-ok', text: '✓ p95: 124ms → 82ms  (-34%)' },
      ],
      footer: 'Claude 和 Codex 双引擎，一套 Discord 界面管理。',
    },
  ] satisfies OneServerScene[],
  footnote: '每个 category 一个本地项目。你有多少项目就开多少 category。',
} as const;

export const howItWorksContent = {
  eyebrow: 'THE FLOW',
  title: '三步，把 Discord 变成你的远程编程工作台。',
  description: '不用搭服务器，不用付订阅，整个流程跑在你自己的机器上。',
  phases: [
    {
      id: 'setup',
      step: '01',
      badge: 'SETUP',
      location: '在家，一次性',
      title: '挂载项目，启动守护进程，绑定 Discord',
      detail:
        '本机装 CLI、在项目目录里 init、后台跑起 bot，最后在 Discord 里选一个频道运行 `/project setup` 把它绑到项目上。想开机自启就加一步 `workspacecord daemon install`。',
      commands: [
        { cmd: 'pnpm i -g workspacecord', note: '全局安装 CLI' },
        { cmd: 'cd ~/projects/my-app && workspacecord project init', note: '挂载当前项目' },
        { cmd: 'workspacecord', note: '启动 bot，连上你的 Discord 服务器' },
        { cmd: '/project setup project:my-app', note: 'Discord 里：把当前频道绑为控制频道' },
      ],
      discord: {
        title: '你的 Discord 服务器',
        lines: [
          '▾ 📁 my-app',
          '     # dev   ← 你运行 /project setup 的频道',
          '     # history (forum, 自动创建)',
          '▾ 📁 api-gateway',
          '     # ops',
          '     # history',
        ],
        note: '每个项目一个 Category；#history forum 自动创建；"控制频道"是你指定的任意现有频道',
      },
    },
    {
      id: 'use',
      step: '02',
      badge: 'USE',
      location: '任何地方',
      title: '开一个 session，在 Discord 里发 prompt',
      detail:
        '在控制频道里 `/agent spawn` 开一个新频道 = 一个主 session；然后在这个频道里直接像聊天一样发 prompt，本机的 Claude Code / Codex 就开跑。文件改动、shell 命令这类敏感操作会弹审批卡片，点一下就行。',
      commands: [
        { cmd: '/agent spawn label:fix-auth-bug', note: '创建新频道作为主 session' },
        { cmd: '帮我看下 src/auth.ts 为什么返回 401', note: '正常发消息当 prompt 用' },
        { cmd: '[ ✓ 批准写入 ]  [ ✗ 拒绝 ]', note: '敏感操作的审批卡片' },
      ],
      discord: {
        title: '#fix-auth-bug',
        lines: [
          '🧠 claude · reading src/auth.ts',
          '🧠 claude · editing middleware.ts',
          '⚠ awaiting approval: write file',
          '✅ 3 tests passed',
        ],
        note: '频道 = 一个独立 session，消息 = prompt，审批 = 按钮',
      },
    },
    {
      id: 'scale',
      step: '03',
      badge: 'SCALE',
      location: '多 session 并发',
      title: '多频道并行，子任务走线程，完事归档',
      detail:
        '同一个项目可以同时开多个频道，每个频道就是一个独立 session。需要拆子任务时 `/subagent run` 在当前频道下开 thread。完事 `/agent archive` 把频道归档进 `#history` forum。',
      commands: [
        { cmd: '/agent spawn label:refactor-payment', note: '并发的第二个 session' },
        { cmd: '/subagent run label:run-tests', note: '当前 session 下开子线程' },
        { cmd: '/agent archive', note: '归档 session 到 #history forum' },
      ],
      discord: {
        title: '多线并发',
        lines: [
          '# refactor-payment     · running',
          '# fix-auth-bug        · awaiting',
          '  └─ thread: run-tests · streaming',
          '# history (forum)     · 23 archived',
        ],
        note: '主频道干净、子任务进 thread、完事自动归档',
      },
    },
  ],
} as const;

export const capabilitiesContent = {
  eyebrow: 'WHY DEVS LOVE IT',
  title: '不止是套壳。',
  description: 'workspacecord 把一堆硬核能力压进 Discord 的极简界面里。',
  items: [
    {
      id: 'hierarchy',
      tag: 'NATIVE HIERARCHY',
      title: '4 层 Discord 原生结构，规模就是优势',
      body: 'Server / Category / Channel / Thread 一对一映射到 工作台 / 项目 / Session / Subagent。同时跑 10 个项目、50 个 session？Discord sidebar 天生就是管这个的——unread、@mention、search、forum 归档全部白嫖。',
      size: 'large',
    },
    {
      id: 'engines',
      tag: 'DUAL ENGINE',
      title: 'Claude Code + Codex',
      body: '两大引擎一套接口。每个 session 任选一个引擎，不同 session 用不同模型并行跑，管理和审批走同一套界面。',
      size: 'medium',
    },
    {
      id: 'monitor',
      tag: 'MONITOR MODE',
      title: 'worker-monitor 自治循环',
      body: '一个 agent 干活，一个 agent 校验结果，最多 6 轮直到任务交付。夜里挂着自动推进。',
      size: 'medium',
    },
    {
      id: 'approval',
      tag: 'REMOTE APPROVAL',
      title: 'Discord 点按钮批准',
      body: '写入 / shell 这类敏感操作弹审批卡片，地铁上点一下就过。',
      size: 'small',
    },
    {
      id: 'mcp',
      tag: 'PROJECT-LEVEL',
      title: 'MCP / 人格 / Skills 都挂项目',
      body: '每个项目独立的 MCP 注册、人格提示词、可复用 skill 库，换项目不污染全局。',
      size: 'small',
    },
    {
      id: 'history',
      tag: 'HISTORY FORUM',
      title: '#history forum 自动归档',
      body: '完成的 session 归档进 Discord forum，随时搜索、回看。',
      size: 'small',
    },
  ],
} as const;

export const quickStartContent = {
  eyebrow: 'QUICK START',
  title: '三行命令，一分钟。',
  description: '复制粘贴就能跑，全程在你自己的机器上。',
  steps: [
    { step: '01', command: 'pnpm i -g workspacecord', label: '全局安装' },
    { step: '02', command: 'workspacecord project init', label: '挂载项目' },
    { step: '03', command: 'workspacecord', label: '启动 → 打开 Discord' },
  ],
} as const;

export const finalCtaContent = {
  eyebrow: 'READY',
  title: '关掉笔电盖。',
  titleAccent: '打开 Discord。继续干活。',
  description: '免费、开源、你的机器你做主。',
  primary: {
    label: '一分钟跑起来',
    href: '#quick-start',
  },
  secondary: {
    label: '前往 GitHub',
    href: 'https://github.com/xuhongbo/WorkspaceCord',
  },
} as const;
