export type WorkflowStepId =
  | 'local-limit'
  | 'discord-launch'
  | 'category-project'
  | 'channel-session'
  | 'subagent-threads'
  | 'history-archive';

export type DesktopFocus = 'terminal' | 'discord';
export type WindowState = 'hidden' | 'foreground' | 'background' | 'docked';

export type WorkflowProject = {
  id: string;
  name: string;
  categoryLabel: string;
  state: 'hidden' | 'mapped' | 'focused' | 'dimmed';
};

export type WorkflowSession = {
  id: string;
  title: string;
  channel: string;
  state: 'hidden' | 'active' | 'archived';
};

export type WorkflowThread = {
  id: string;
  title: string;
  state: 'hidden' | 'running' | 'queued' | 'synced';
};

export type WorkflowDockApp = {
  id: 'terminal' | 'discord';
  label: string;
  state: 'idle' | 'glowing' | 'active';
};

export type WorkflowDiscordMessage = {
  id: string;
  author: string;
  body: string;
  tone: 'neutral' | 'active' | 'success';
};

export type WorkflowScene = {
  desktopFocus: DesktopFocus;
  terminal: {
    windowState: WindowState;
    title: string;
    lines: string[];
  };
  dock: {
    activeApp: WorkflowDockApp['id'] | null;
    presentation: 'ambient' | 'handoff';
    apps: WorkflowDockApp[];
  };
  discord: {
    windowState: WindowState;
    serverName: string;
    categories: WorkflowProject[];
    selectedCategoryId: string | null;
    mainSession: WorkflowSession | null;
    threads: WorkflowThread[];
    messages: WorkflowDiscordMessage[];
    history: {
      channel: '#history';
      highlighted: boolean;
      summary: string | null;
    };
  };
};

export type WorkflowStep = {
  id: WorkflowStepId;
  shortLabel: string;
  title: string;
  body: string;
  status: string;
  scene: WorkflowScene;
};

/* ---- Data pool ---- */

const projectPoolBase = [
  {
    id: 'gateway',
    name: 'api-gateway',
    categoryLabel: 'CATEGORY / api-gateway',
  },
  {
    id: 'billing',
    name: 'billing-service',
    categoryLabel: 'CATEGORY / billing-service',
  },
  {
    id: 'console',
    name: 'admin-console',
    categoryLabel: 'CATEGORY / admin-console',
  },
] as const;

const focusSession: WorkflowSession = {
  id: 'session-auth-rollout',
  title: 'session / auth-rollout',
  channel: '#auth-rollout',
  state: 'active',
};

const focusThreads: WorkflowThread[] = [
  {
    id: 'thread-analysis',
    title: 'thread / 分析鉴权链路',
    state: 'running',
  },
  {
    id: 'thread-migration',
    title: 'thread / 迁移脚本回归',
    state: 'queued',
  },
  {
    id: 'thread-verify',
    title: 'thread / 验证灰度日志',
    state: 'running',
  },
];

function createCategories(selectedCategoryId: string | null): WorkflowProject[] {
  return projectPoolBase.map((project) => ({
    ...project,
    state:
      selectedCategoryId === null
        ? 'mapped'
        : project.id === selectedCategoryId
          ? 'focused'
          : 'dimmed',
  }));
}

function createDock(activeApp: WorkflowDockApp['id'] | null): WorkflowDockApp[] {
  return [
    {
      id: 'terminal',
      label: 'CLI',
      state: activeApp === 'terminal' ? 'active' : activeApp === 'discord' ? 'idle' : 'glowing',
    },
    {
      id: 'discord',
      label: 'Discord',
      state: activeApp === 'discord' ? 'active' : activeApp === 'terminal' ? 'glowing' : 'idle',
    },
  ];
}

/* ---- Six scenes: remote limitation → Discord workbench → Category=Project → Channel=Session → Threads → History ---- */

export const workflowSteps: WorkflowStep[] = [
  {
    id: 'local-limit',
    shortLabel: '01',
    title: '本地工具，远程受限',
    body: 'Claude Code 只能本地，Codex 远程要订阅。你想在任何地方编程？缺一个免费的工作台。',
    status: 'Local tools, remote limited',
    scene: {
      desktopFocus: 'terminal',
      terminal: {
        windowState: 'foreground',
        title: 'The Problem',
        lines: [
          '$ claude-code --remote',
          '✗ error: local only — remote access not available',
          '$ codex --remote-session',
          '✗ error: remote sessions require paid subscription',
          '',
          '• 没有免费的远程编程工作台',
        ],
      },
      dock: {
        activeApp: 'terminal',
        presentation: 'ambient',
        apps: createDock('terminal'),
      },
      discord: {
        windowState: 'hidden',
        serverName: '',
        categories: [],
        selectedCategoryId: null,
        mainSession: null,
        threads: [],
        messages: [],
        history: {
          channel: '#history',
          highlighted: false,
          summary: null,
        },
      },
    },
  },
  {
    id: 'discord-launch',
    shortLabel: '02',
    title: 'Discord 工作台出现',
    body: 'workspacecord 用 Discord 作为远程编程工作台。一个服务器，承载所有项目。',
    status: 'Discord workbench launching',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'docked',
        title: 'WorkspaceCord CLI',
        lines: [
          '$ workspacecord start',
          '✓ daemon running',
          '✓ connected to Discord',
          '• workbench ready',
        ],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'handoff',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        categories: [],
        selectedCategoryId: null,
        mainSession: null,
        threads: [],
        messages: [
          {
            id: 'launch-control',
            author: 'workspacecord',
            body: 'Discord 工作台已连接。分类=项目，频道=session，一切井井有条。',
            tone: 'neutral',
          },
        ],
        history: {
          channel: '#history',
          highlighted: false,
          summary: null,
        },
      },
    },
  },
  {
    id: 'category-project',
    shortLabel: '03',
    title: '分类=项目',
    body: '每个 Category 对应一个项目，Discord 服务器结构清晰映射你的代码库。',
    status: 'Categories forming for projects',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: [
          '$ workspacecord project init --batch api-gateway,billing-service,admin-console',
          '✓ api-gateway → CATEGORY / api-gateway',
          '✓ billing-service → CATEGORY / billing-service',
          '✓ admin-console → CATEGORY / admin-console',
        ],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        categories: createCategories(null),
        selectedCategoryId: null,
        mainSession: null,
        threads: [],
        messages: [
          {
            id: 'cat-control',
            author: 'workspacecord',
            body: '3 个项目已映射，每个 Category = 一个项目。',
            tone: 'active',
          },
        ],
        history: {
          channel: '#history',
          highlighted: false,
          summary: null,
        },
      },
    },
  },
  {
    id: 'channel-session',
    shortLabel: '04',
    title: '频道=session',
    body: '每个 Category 下出现频道，#control 是主会话频道，每个频道对应一个 session。',
    status: 'Channels forming sessions',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: [
          '/agent spawn label:auth-rollout',
          '✓ session created in #auth-rollout',
          '• provider: claude-code',
        ],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        categories: createCategories('gateway'),
        selectedCategoryId: 'gateway',
        mainSession: focusSession,
        threads: [],
        messages: [
          {
            id: 'session-control',
            author: '#auth-rollout',
            body: 'session auth-rollout 已启动，provider: Claude Code，模式: auto',
            tone: 'active',
          },
          {
            id: 'session-state',
            author: 'workspacecord',
            body: '频道 = session，结构清晰，一目了然。',
            tone: 'success',
          },
        ],
        history: {
          channel: '#history',
          highlighted: false,
          summary: null,
        },
      },
    },
  },
  {
    id: 'subagent-threads',
    shortLabel: '05',
    title: '子线程并发',
    body: '主会话下派生子线程（/subagent run），多个任务并发执行，互不阻塞。',
    status: 'Subagent threads running',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: [
          '/subagent run label:分析鉴权链路',
          '/subagent run label:验证灰度日志',
          '✓ 2 subagents dispatched',
        ],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        categories: createCategories('gateway'),
        selectedCategoryId: 'gateway',
        mainSession: focusSession,
        threads: focusThreads,
        messages: [
          {
            id: 'thread-main',
            author: '#auth-rollout',
            body: '拆解 auth rollout，派生两个子任务并发执行。',
            tone: 'active',
          },
          {
            id: 'thread-analysis',
            author: 'thread / 分析鉴权链路',
            body: '已定位主入口与回调节点，正在整理风险面。',
            tone: 'neutral',
          },
          {
            id: 'thread-verify',
            author: 'thread / 验证灰度日志',
            body: '灰度日志采样中，等待与主会话同步。',
            tone: 'active',
          },
        ],
        history: {
          channel: '#history',
          highlighted: false,
          summary: null,
        },
      },
    },
  },
  {
    id: 'history-archive',
    shortLabel: '06',
    title: '#history 全流程可追溯',
    body: '会话完成后自动归档到 #history，团队任何人可随时回看追溯。',
    status: 'History archive synced',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: [
          '/end session:auth-rollout',
          '✓ session closed',
          '✓ archived to #history',
        ],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        categories: createCategories('gateway'),
        selectedCategoryId: 'gateway',
        mainSession: {
          ...focusSession,
          state: 'archived',
        },
        threads: focusThreads.map((thread) => ({
          ...thread,
          state: 'synced',
        })),
        messages: [
          {
            id: 'history-main',
            author: '#auth-rollout',
            body: 'session 已完成，结果归档到 #history。',
            tone: 'neutral',
          },
          {
            id: 'history-sync',
            author: '#history',
            body: 'archive complete / full trace available',
            tone: 'success',
          },
        ],
        history: {
          channel: '#history',
          highlighted: true,
          summary: 'auth-rollout archived / full trace / team-readable',
        },
      },
    },
  },
];

export function getNextWorkflowIndex(currentIndex: number, total: number): number {
  return (currentIndex + 1) % total;
}
