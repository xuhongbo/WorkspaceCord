export type WorkflowStepId =
  | 'terminal-boot'
  | 'dock-handoff'
  | 'discord-launch'
  | 'project-map'
  | 'session-expand'
  | 'history-archive';

export type DesktopFocus = 'terminal' | 'dock' | 'discord';
export type WindowState = 'hidden' | 'foreground' | 'background' | 'launching' | 'docked';

export type WorkflowProject = {
  id: string;
  name: string;
  rootPath: string;
  state: 'hidden' | 'mapped' | 'focused' | 'dimmed';
};

export type WorkflowSession = {
  id: string;
  title: string;
  state: 'hidden' | 'active' | 'archived';
};

export type WorkflowThread = {
  id: string;
  title: string;
  parentSessionId: string;
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
    projects: WorkflowProject[];
    selectedProjectId: string | null;
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

const projectPoolBase = [
  {
    id: 'gateway',
    name: 'api-gateway',
    rootPath: '~/workspace/api-gateway',
  },
  {
    id: 'billing',
    name: 'billing-service',
    rootPath: '~/workspace/billing-service',
  },
  {
    id: 'console',
    name: 'admin-console',
    rootPath: '~/workspace/admin-console',
  },
] as const;

const focusSession: WorkflowSession = {
  id: 'session-auth-rollout',
  title: 'session / auth-rollout',
  state: 'active',
};

const focusThreads: WorkflowThread[] = [
  {
    id: 'thread-analysis',
    title: 'thread / 分析鉴权链路',
    parentSessionId: focusSession.id,
    state: 'running',
  },
  {
    id: 'thread-migration',
    title: 'thread / 回归迁移脚本',
    parentSessionId: focusSession.id,
    state: 'queued',
  },
  {
    id: 'thread-verify',
    title: 'thread / 验证灰度日志',
    parentSessionId: focusSession.id,
    state: 'running',
  },
];

function createProjects(selectedProjectId: string | null): WorkflowProject[] {
  return projectPoolBase.map((project) => ({
    ...project,
    state:
      selectedProjectId === null
        ? 'mapped'
        : project.id === selectedProjectId
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

export const workflowSteps: WorkflowStep[] = [
  {
    id: 'terminal-boot',
    shortLabel: '01',
    title: '本地命令行挂载多个项目',
    body: '先在本地启动命令行守护进程，把多个项目接入同一条工作流。',
    status: 'Local terminal booting',
    scene: {
      desktopFocus: 'terminal',
      terminal: {
        windowState: 'foreground',
        title: 'WorkspaceCord CLI',
        lines: [
          '$ workspacecord project init --batch api-gateway,billing-service,admin-console',
          '✓ mounted api-gateway',
          '✓ mounted billing-service',
          '✓ mounted admin-console',
          '$ workspacecord',
          '• daemon ready',
        ],
      },
      dock: {
        activeApp: 'terminal',
        presentation: 'ambient',
        apps: createDock('terminal'),
      },
      discord: {
        windowState: 'hidden',
        serverName: 'workspace-hub',
        projects: [],
        selectedProjectId: null,
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
    id: 'dock-handoff',
    shortLabel: '02',
    title: '命令行缩入 Dock，准备切到 Discord',
    body: '本地守护进程就绪后，焦点向 Dock 交接，提示协作界面即将拉起。',
    status: 'Dock handoff ready',
    scene: {
      desktopFocus: 'dock',
      terminal: {
        windowState: 'docked',
        title: 'WorkspaceCord CLI',
        lines: [
          '$ workspacecord project init --batch api-gateway,billing-service,admin-console',
          '✓ mounted api-gateway',
          '✓ mounted billing-service',
          '✓ mounted admin-console',
          '$ workspacecord',
          '• daemon ready',
          '• handoff prepared for Discord',
        ],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'handoff',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'hidden',
        serverName: 'workspace-hub',
        projects: [],
        selectedProjectId: null,
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
    shortLabel: '03',
    title: '拉起 Discord 窗口',
    body: 'Dock 激活 Discord，桌面焦点切到服务器视图，准备承接项目映射。',
    status: 'Discord window launched',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: [
          '$ workspacecord',
          '• daemon ready',
          '• handoff prepared for Discord',
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
        projects: [],
        selectedProjectId: null,
        mainSession: null,
        threads: [],
        messages: [
          {
            id: 'launch-control',
            author: 'control channel',
            body: 'WorkspaceCord 已连接本地守护进程，正在准备映射服务器结构。',
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
    id: 'project-map',
    shortLabel: '04',
    title: '多个项目映射进 Discord 服务器',
    body: '同一个服务器下出现多个本地项目，先建立总览关系，再进入单项目执行。',
    status: 'Projects mapped into Discord',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: ['$ workspacecord', '• daemon ready', '• Discord sync active'],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        projects: createProjects(null),
        selectedProjectId: null,
        mainSession: null,
        threads: [],
        messages: [
          {
            id: 'map-control',
            author: 'control channel',
            body: '检测到 3 个本地项目，正在映射到 workspace-hub。',
            tone: 'active',
          },
          {
            id: 'map-success',
            author: 'discord bridge',
            body: '项目总览已建立，现在可以聚焦单项目继续派生会话。',
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
    id: 'session-expand',
    shortLabel: '05',
    title: '展开项目会话与线程',
    body: '聚焦 api-gateway 后，主会话先出现，再继续派生多个执行线程。',
    status: 'Session threads expanding',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: ['$ workspacecord', '• daemon ready', '• streaming project updates'],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        projects: createProjects('gateway'),
        selectedProjectId: 'gateway',
        mainSession: focusSession,
        threads: focusThreads,
        messages: [
          {
            id: 'session-main',
            author: 'main session',
            body: '拆解 auth rollout，先确认鉴权链路与灰度验证。',
            tone: 'active',
          },
          {
            id: 'session-thread-analysis',
            author: 'thread / 分析鉴权链路',
            body: '已定位主入口与回调节点，正在整理风险面。',
            tone: 'neutral',
          },
          {
            id: 'session-thread-verify',
            author: 'thread / 验证灰度日志',
            body: '灰度日志采样中，等待与主会话同步结论。',
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
    title: '结果收束到 #history',
    body: '执行完成后，所有线程的结果汇总到 #history，形成可回看的审计轨迹。',
    status: 'History archive synced',
    scene: {
      desktopFocus: 'discord',
      terminal: {
        windowState: 'background',
        title: 'WorkspaceCord CLI',
        lines: ['$ workspacecord', '• daemon ready', '• archive sync complete'],
      },
      dock: {
        activeApp: 'discord',
        presentation: 'ambient',
        apps: createDock('discord'),
      },
      discord: {
        windowState: 'foreground',
        serverName: 'workspace-hub',
        projects: createProjects('gateway'),
        selectedProjectId: 'gateway',
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
            author: 'main session',
            body: 'auth-rollout 已关闭，正在把结果同步到历史频道。',
            tone: 'neutral',
          },
          {
            id: 'history-sync',
            author: 'history summary',
            body: 'summary posted / follow-up ready',
            tone: 'success',
          },
        ],
        history: {
          channel: '#history',
          highlighted: true,
          summary: 'auth-rollout closed / summary posted / follow-up ready',
        },
      },
    },
  },
];

export function getNextWorkflowIndex(currentIndex: number, total: number): number {
  return (currentIndex + 1) % total;
}
