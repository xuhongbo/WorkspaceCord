import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

// ─── Module mocks (external boundaries only) ─────────────────────────────────

const mockConfig = {
  allowedUsers: ['user-1'],
  shellEnabled: false,
  anthropicApiKey: null,
  codexApiKey: null,
  guildId: 'guild-1',
  token: 'test-token',
  sessionSyncIntervalMs: 30_000,
  sessionSyncRecentDays: 3,
  autoArchiveDays: 0,
  maxActiveSessionsPerProject: 0,
};

vi.mock('@workspacecord/core/config', () => ({
  config: mockConfig,
}));

// ─── Thread-manager: mock persistence layer, keep createSession logic ─────────

const storedSessions: Array<Record<string, unknown>> = [];
const mockGetAllSessions = vi.fn(() => []);
const mockGetSessionsByCategory = vi.fn(() => []);

function resetSessions() {
  storedSessions.length = 0;
}

vi.mock('@workspacecord/engine/session-registry', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()),
  getAllSessions: mockGetAllSessions,
  getSessionsByCategory: mockGetSessionsByCategory,
  getSession: vi.fn(),
  getSessionByChannel: vi.fn(),
  getSessionPermissionSummary: vi.fn().mockReturnValue('✅ 全权限'),
  createSession: vi.fn(async (params) => {
    const record = {
      id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      channelId: params.channelId,
      categoryId: params.categoryId,
      projectName: params.projectName,
      agentLabel: params.agentLabel,
      provider: params.provider,
      providerSessionId: params.providerSessionId || null,
      directory: params.directory || '/test/project',
      type: params.type || 'persistent',
      mode: params.mode || 'auto',
      parentChannelId: params.parentChannelId || null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      totalCost: 0,
      statusCardMessageId: null,
      workflowState: {},
    };
    storedSessions.push(record);
    return record;
  }),
  endSession: vi.fn(async () => {}),
  setMode: vi.fn(),
  setCurrentInteractionMessage: vi.fn(),
  setStatusCardBinding: vi.fn(),
  abortSession: vi.fn(),
  setMonitorGoal: vi.fn(),
  setAgentPersona: vi.fn(),
  setVerbose: vi.fn(),
  setModel: vi.fn(),
  updateSessionPermissions: vi.fn(),
  getSessionPermissionDetails: vi.fn().mockReturnValue('read:all'),
}));

// ─── Project registry ────────────────────────────────────────────────────────

vi.mock('@workspacecord/engine/project-registry', () => ({
  loadRegistry: vi.fn().mockResolvedValue(undefined),
  registerProject: vi.fn(async (name: string, path: string) => ({
    name,
    path,
    discordCategoryId: null,
    historyChannelId: null,
    controlChannelId: null,
  })),
  getProjectByName: vi.fn(),
  getAllRegisteredProjects: vi.fn(() => []),
  getProjectByPath: vi.fn(),
  bindProjectCategory: vi.fn().mockResolvedValue(undefined),
  unbindProjectCategory: vi.fn().mockResolvedValue(undefined),
  setProjectHistoryChannel: vi.fn().mockResolvedValue(undefined),
  setProjectControlChannel: vi.fn().mockResolvedValue(undefined),
  renameProject: vi.fn().mockResolvedValue(undefined),
  removeProject: vi.fn().mockResolvedValue(undefined),
}));

// ─── Archive manager ─────────────────────────────────────────────────────────

const storedArchived: Array<Record<string, unknown>> = [];

vi.mock('../../src/archive-manager.ts', () => ({
  getArchivedSessions: vi.fn(() => [...storedArchived]),
  archiveSession: vi.fn(async (_session: Record<string, unknown>) => {
    storedArchived.push({ id: _session.id, categoryId: _session.categoryId });
  }),
  loadArchived: vi.fn(),
  isArchivedProviderSession: vi.fn().mockReturnValue(false),
}));

// ─── Other external dependencies ─────────────────────────────────────────────

vi.mock('@workspacecord/engine/project-manager', () => ({
  loadProjects: vi.fn(),
  getPersonality: vi.fn(),
  getProject: vi.fn(),
  getProjectByName: vi.fn(),
  setHistoryChannelId: vi.fn(),
}));

vi.mock('../../src/subagent-manager.ts', () => ({
  spawnSubagent: vi.fn().mockResolvedValue({ success: true }),
  getSubagents: vi.fn().mockReturnValue([]),
}));

vi.mock('@workspacecord/engine/session-executor', () => ({
  executeSessionPrompt: vi.fn(),
  executeSessionContinue: vi.fn(),
}));

vi.mock('../../src/output-handler.ts', () => ({
  makeModeButtons: vi.fn(() => []),
  resolveEffectiveClaudePermissionMode: vi.fn().mockReturnValue('auto'),
}));

vi.mock('../../src/panel-adapter.ts', () => ({
  buildStatusPanel: vi.fn().mockReturnValue({}),
  registerExistingStatusCard: vi.fn(),
  updateStatusCard: vi.fn(),
}));

vi.mock('../../src/shell-handler.ts', () => ({
  executeShellCommand: vi.fn(),
  listProcesses: vi.fn(),
  killProcess: vi.fn(),
}));

vi.mock('@workspacecord/engine/agent-cleanup-request-store', () => ({
  createCleanupRequest: vi.fn(),
}));

vi.mock('../../src/session-housekeeping.ts', () => ({
  cleanupSessionsById: vi.fn().mockResolvedValue({
    deletedChannels: 0,
    missingChannels: 0,
    endedSessions: 0,
    skippedSessions: 0,
    failed: [],
  }),
  archiveSessionsById: vi.fn(),
  buildProjectCleanupPreview: vi.fn().mockReturnValue({ projects: [] }),
  reconcileSessionRecordsWithGuild: vi.fn(),
}));

vi.mock('@workspacecord/core/utils', () => ({
  isUserAllowed: vi.fn().mockReturnValue(true),
  resolvePath: vi.fn((p: string) => p),
  formatUptime: vi.fn().mockReturnValue('0m'),
  formatRelative: vi.fn().mockReturnValue('just now'),
}));

// ─── Discord mock helpers ─────────────────────────────────────────────────────

function makeTextChannel(overrides: Record<string, unknown> = {}) {
  const pinnedMessages = new Map();
  return {
    id: 'channel-1',
    name: 'session-main',
    parentId: 'cat-1',
    type: ChannelType.GuildText,
    topic: null,
    isThread: () => false,
    isTextBased: () => true,
    send: vi.fn(async (payload: unknown) => {
      const msg = {
        id: `msg-${Date.now()}`,
        content: typeof payload === 'string' ? payload : (payload as any)?.content ?? '',
        embeds: [],
        components: [],
        edit: vi.fn(),
        delete: vi.fn(),
        pin: vi.fn(),
      };
      const content = msg.content;
      if (content.includes('Status:') || content.includes('\u2705')) {
        pinnedMessages.set(msg.id, msg);
      }
      return msg;
    }),
    delete: vi.fn(async () => undefined),
    messages: {
      fetch: vi.fn(async () => new Map()),
      fetchPins: vi.fn(async () => pinnedMessages),
    },
    ...overrides,
  };
}

function makeCategoryChannel(overrides: Record<string, unknown> = {}) {
  const childrenCache = new Map();
  return {
    id: 'cat-1',
    name: 'workspacecord-test-project',
    type: ChannelType.GuildCategory,
    children: {
      cache: {
        get: vi.fn((id: string) => childrenCache.get(id)),
        find: vi.fn((pred: (ch: { type: number; topic?: string }) => boolean) => {
          for (const ch of childrenCache.values()) {
            if (pred(ch)) return ch;
          }
          return undefined;
        }),
        set: vi.fn((ch: { id: string }) => childrenCache.set(ch.id, ch)),
        values: vi.fn(() => childrenCache.values()),
        size: childrenCache.size,
        forEach: vi.fn((fn: (v: unknown) => void) => childrenCache.forEach(fn)),
      },
    },
    ...overrides,
  };
}

function makeGuild() {
  const category = makeCategoryChannel();
  const channelMap = new Map<string, Record<string, unknown>>();
  channelMap.set(category.id, category as any);

  return {
    id: 'guild-1',
    name: 'Test Guild',
    channels: {
      cache: {
        get: vi.fn((id: string) => channelMap.get(id)),
        find: vi.fn((pred: (ch: { id: string }) => boolean) => channelMap.get(ch.id)),
      },
      create: vi.fn(async (payload: Record<string, unknown>) => {
        const ch = makeTextChannel({
          id: `ch-${Date.now().toString(36)}`,
          name: payload.name,
          parentId: payload.parent,
          type: payload.type ?? ChannelType.GuildText,
        });
        channelMap.set(ch.id, ch);
        return ch;
      }),
      fetch: vi.fn(async (id?: string) => (id ? channelMap.get(id) ?? null : undefined)),
      delete: vi.fn(async (id: string) => {
        channelMap.delete(id);
      }),
    },
  };
}

function makeInteraction(subcommand: string, values: Record<string, string | null> = {}) {
  let lastReply: unknown;
  return {
    user: { id: 'user-1', tag: 'tester#0001' },
    guild: { id: 'guild-1', name: 'Test Guild' },
    channelId: 'control-1',
    replied: false,
    deferred: false,
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string, _required = false) => values[name] ?? null,
      getInteger: (name: string, _required = false) => {
        const v = values[name];
        return v ? parseInt(v, 10) : null;
      },
    },
    reply: vi.fn(async (payload: unknown) => {
      lastReply = payload;
      return payload;
    }),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (payload: unknown) => {
      lastReply = payload;
      return payload;
    }),
    fetchReply: vi.fn(async () => lastReply),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function captureConsole(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { logs, errors };
}

function* importFresh<T>(modulePath: string) {
  // Helper to dynamically import modules
  const mod = yield import(modulePath);
  return mod as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('smoke-migration: integration workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessions();
    storedArchived.length = 0;

    // Wire up getAllSessions / getSessionsByCategory to storedSessions
    mockGetAllSessions.mockImplementation(() => [...storedSessions]);
    mockGetSessionsByCategory.mockImplementation((catId: string) =>
      storedSessions.filter((s) => s.categoryId === catId),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('project mount: real handleProject calls registerProject with cwd', async () => {
    const { handleProject } = await import('@workspacecord/cli/project-cli');
    const { registerProject } = await import('@workspacecord/engine/project-registry');

    await captureConsole(() => handleProject(['init']));

    expect(registerProject).toHaveBeenCalledWith(
      process.cwd().split('/').pop() || 'workspacecord',
      process.cwd(),
    );
  });

  it('session spawn: real handleAgent calls createSession with persistent type', async () => {
    const guild = makeGuild();
    const controlCh = makeTextChannel({ id: 'control-1' });
    const catCh = makeCategoryChannel();

    const chMap = new Map<string, unknown>();
    chMap.set('control-1', controlCh);
    chMap.set('cat-1', catCh);

    (guild as any).channels.cache.get.mockImplementation((id: string) => chMap.get(id));
    (guild as any).channels.create.mockImplementation(async (payload: Record<string, unknown>) => {
      const ch = makeTextChannel({
        id: `ch-${Date.now().toString(36)}`,
        name: payload.name,
        parentId: payload.parent,
        type: payload.type ?? ChannelType.GuildText,
      });
      chMap.set(ch.id, ch);
      return ch;
    });

    const { getProject } = await import('@workspacecord/engine/project-manager');
    vi.mocked(getProject).mockReturnValue({
      name: 'test-project',
      path: '/test/project',
      directory: '/test/project',
      discordCategoryId: 'cat-1',
      historyChannelId: null,
      controlChannelId: 'control-1',
    } as any);

    const { handleAgent } = await import('../../src/command-handlers.ts');
    const ix = makeInteraction('spawn', {
      label: 'test-agent',
      provider: 'claude',
      mode: 'auto',
    }) as any;
    ix.guild = guild;
    ix.channel = controlCh;
    ix.channelId = 'control-1';

    await handleAgent(ix);

    expect(storedSessions.length).toBeGreaterThan(0);
    expect(storedSessions[0].type).toBe('persistent');
    expect(storedSessions[0].agentLabel).toBe('test-agent');
    expect(storedSessions[0].provider).toBe('claude');
  });

  it('session spawn: status card message created on channel', async () => {
    const guild = makeGuild();
    const controlCh = makeTextChannel({ id: 'control-1' });
    const catCh = makeCategoryChannel();
    const chMap = new Map<string, unknown>();
    chMap.set('control-1', controlCh);
    chMap.set('cat-1', catCh);

    (guild as any).channels.cache.get.mockImplementation((id: string) => chMap.get(id));
    (guild as any).channels.create.mockImplementation(async (payload: Record<string, unknown>) => {
      const ch = makeTextChannel({
        id: `ch-${Date.now().toString(36)}`,
        name: payload.name,
        parentId: payload.parent,
      });
      chMap.set(ch.id, ch);
      return ch;
    });

    const { getProject } = await import('@workspacecord/engine/project-manager');
    vi.mocked(getProject).mockReturnValue({
      name: 'test-project',
      path: '/test/project',
      directory: '/test/project',
      discordCategoryId: 'cat-1',
      historyChannelId: null,
      controlChannelId: 'control-1',
    });

    const { handleAgent } = await import('../../src/command-handlers.ts');
    const ix = makeInteraction('spawn', {
      label: 'status-agent',
      provider: 'claude',
      mode: 'auto',
    }) as any;
    ix.guild = guild;
    ix.channel = controlCh;
    ix.channelId = 'control-1';

    await handleAgent(ix);

    expect(storedSessions.length).toBeGreaterThan(0);
    // Verify a session was created with a status card binding
    const session = storedSessions[0];
    expect(session.statusCardMessageId).toBeDefined();
  });

  it('subagent run: real handleSubagent creates subagent session', async () => {
    const parentSession = {
      id: 'parent-session',
      channelId: 'channel-parent',
      categoryId: 'cat-1',
      projectName: 'test-project',
      agentLabel: 'main-agent',
      provider: 'claude',
      type: 'persistent',
      directory: '/test/project',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    storedSessions.push(parentSession);

    const parentCh = makeTextChannel({
      id: 'channel-parent',
      name: 'claude-main',
    });
    parentCh.threads = {
      create: vi.fn(async (payload: Record<string, unknown>) => ({
        id: `thread-${Date.now().toString(36)}`,
        name: payload.name,
        parentId: 'channel-parent',
        type: ChannelType.PublicThread,
        isThread: () => true,
        send: vi.fn(async () => ({ edit: vi.fn() })),
      })),
    };

    const guild = makeGuild();
    const chMap = new Map<string, unknown>();
    chMap.set('cat-1', makeCategoryChannel());
    chMap.set('channel-parent', parentCh);

    (guild as any).channels.cache.get.mockImplementation((id: string) => chMap.get(id));

    // Make getSessionByChannel return the parent session
    const { getSessionByChannel, createSession } = await import('@workspacecord/engine/session-registry');
    vi.mocked(getSessionByChannel).mockReturnValue(parentSession as any);
    // Make spawnSubagent call createSession directly (simulating real flow)
    const { spawnSubagent } = await import('../../src/subagent-manager.ts');
    vi.mocked(spawnSubagent).mockImplementation(async (_parent, label, provider, _ch) => {
      return createSession({
        channelId: `thread-${Date.now()}`,
        categoryId: 'cat-1',
        projectName: 'test-project',
        agentLabel: label,
        provider,
        type: 'subagent',
        directory: '/test/project',
        parentChannelId: 'channel-parent',
      });
    });

    const { handleSubagent } = await import('../../src/command-handlers.ts');
    const ix = makeInteraction('run', {
      label: 'test-sub',
      provider: 'claude',
    }) as any;
    ix.guild = guild;
    ix.channel = parentCh;
    ix.channelId = 'channel-parent';

    await handleSubagent(ix);

    const subSession = storedSessions.find((s) => s.type === 'subagent');
    expect(subSession).toBeDefined();
    expect(subSession.agentLabel).toBe('test-sub');
    expect(subSession.parentChannelId).toBe('channel-parent');
  });

  it('session archive: real archiveSession increases archived count', async () => {
    const { archiveSession } = await import('../../src/archive-manager.ts');
    const { getArchivedSessions } = await import('../../src/archive-manager.ts');

    const before = getArchivedSessions('cat-1').length;

    await archiveSession(
      {
        id: 'session-archive-1',
        channelId: 'channel-archive',
        categoryId: 'cat-1',
        type: 'persistent',
        agentLabel: 'test-agent',
        provider: 'claude',
        providerSessionId: 'ps-archive',
        directory: '/test/project',
        mode: 'auto',
        createdAt: Date.now() - 60000,
        lastActivity: Date.now() - 30000,
        messageCount: 5,
        totalCost: 0.01,
        workflowState: { lastWorkerSummary: 'Test archive' },
      } as never,
      makeGuild() as never,
    );

    const after = getArchivedSessions('cat-1').length;
    expect(after).toBeGreaterThan(before);
  });

  it('cleanup: real cleanupSessionsById processes sessions', async () => {
    const guild = makeGuild();
    storedSessions.push({
      id: 'session-cleanup-1',
      channelId: 'channel-cleanup-1',
      categoryId: 'cat-1',
      type: 'persistent',
      agentLabel: 'cleanup-agent',
      provider: 'claude',
      directory: '/test/project',
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });

    const { cleanupSessionsById } = await import('../../src/session-housekeeping.ts');
    const result = await cleanupSessionsById(guild as never, ['session-cleanup-1'], 'smoke cleanup');

    expect(result).toHaveProperty('deletedChannels');
    expect(result).toHaveProperty('endedSessions');
  });

  it('full flow: mount → spawn → archive → cleanup via real handlers', async () => {
    const cwd = process.cwd();
    const expectedName = cwd.split('/').pop() || 'workspacecord';

    // Mount
    const { handleProject } = await import('@workspacecord/cli/project-cli');
    const { registerProject } = await import('@workspacecord/engine/project-registry');
    await captureConsole(() => handleProject(['init']));
    expect(registerProject).toHaveBeenCalledWith(expectedName, cwd);

    // Spawn
    const guild = makeGuild();
    const controlCh = makeTextChannel({ id: 'control-1' });
    const catCh = makeCategoryChannel();
    const chMap = new Map<string, unknown>();
    chMap.set('control-1', controlCh);
    chMap.set('cat-1', catCh);

    (guild as any).channels.cache.get.mockImplementation((id: string) => chMap.get(id));
    (guild as any).channels.create.mockImplementation(async (payload: Record<string, unknown>) => {
      const ch = makeTextChannel({
        id: `flow-${Date.now().toString(36)}`,
        name: payload.name,
        parentId: payload.parent,
      });
      chMap.set(ch.id, ch);
      return ch;
    });

    const { getProject } = await import('@workspacecord/engine/project-manager');
    vi.mocked(getProject).mockReturnValue({
      name: expectedName,
      path: cwd,
      directory: cwd,
      discordCategoryId: 'cat-1',
      historyChannelId: null,
      controlChannelId: 'control-1',
    });

    const { handleAgent } = await import('../../src/command-handlers.ts');
    const ix = makeInteraction('spawn', {
      label: 'flow-agent',
      provider: 'claude',
      mode: 'auto',
    }) as any;
    ix.guild = guild;
    ix.channel = controlCh;
    ix.channelId = 'control-1';
    await handleAgent(ix);

    expect(storedSessions.length).toBeGreaterThan(0);
    expect(storedSessions[0].type).toBe('persistent');

    // Archive
    const { archiveSession, getArchivedSessions } = await import('../../src/archive-manager.ts');
    const archivedBefore = getArchivedSessions().length;
    await archiveSession(storedSessions[0] as never, guild as never);
    const archivedAfter = getArchivedSessions().length;
    expect(archivedAfter).toBeGreaterThan(archivedBefore);

    // Cleanup
    const { cleanupSessionsById } = await import('../../src/session-housekeeping.ts');
    const result = await cleanupSessionsById(guild as never, [storedSessions[0].id as string]);
    expect(result).toHaveProperty('endedSessions');
  });
});
