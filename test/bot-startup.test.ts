import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';

const startHookServer = vi.fn();
const stopHookServer = vi.fn();
const startHookWatcher = vi.fn();
const stopHookWatcher = vi.fn();
const registerCommands = vi.fn();
const loadProjects = vi.fn();
const loadSessions = vi.fn();
const loadArchived = vi.fn();
const startSync = vi.fn();
const stopSync = vi.fn();
const startHealthMonitor = vi.fn();
const stopHealthMonitor = vi.fn();
const setBotStartTime = vi.fn();
const getAllSessions = vi.fn(() => []);
const invalidateAllOnRestart = vi.fn(() => []);
const checkHookHealth = vi.fn(() => ({ isHealthy: true, issues: [], warnings: [] }));
const logHookHealthStatus = vi.fn();
const sendHookHealthNotification = vi.fn();
const buildDeliveryPlan = vi.fn();
const deliver = vi.fn();
const startPerformanceMonitoring = vi.fn();
const stopPerformanceMonitoring = vi.fn();
const reconcileSessionRecordsWithGuild = vi.fn(async () => ({ checkedSessions: 0, endedMissingSessions: 0 }));

let readyHandler: (() => Promise<void> | void) | undefined;

const mockGuild = {
  channels: {
    cache: {
      find: vi.fn(() => null),
    },
    create: vi.fn(async () => ({
      id: 'bot-logs-channel',
      send: vi.fn(),
      messages: { fetch: vi.fn() },
    })),
  },
};

class MockClient {
  public user = {
    tag: 'bot#0001',
    setPresence: vi.fn(),
  };

  public guilds = {
    cache: {
      first: vi.fn(() => mockGuild),
    },
  };

  public channels = {
    cache: {
      get: vi.fn(() => undefined),
    },
  };

  on = vi.fn(() => this);

  once = vi.fn((event: string, handler: () => Promise<void> | void) => {
    if (event === 'ready') {
      readyHandler = handler;
    }
    return this;
  });

  login = vi.fn(async () => {
    await readyHandler?.();
    return 'ok';
  });

  destroy = vi.fn();
}

vi.mock('discord.js', async () => ({
  Client: MockClient,
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildMessageTyping: 8,
  },
  ActivityType: {
    Custom: 1,
    Watching: 2,
  },
  InteractionType: {
    ApplicationCommand: 2,
  },
  ComponentType: {},
  ChannelType: {
    GuildText: 0,
  },
}));

vi.mock('../src/config.ts', () => ({
  config: {
    dataDir: '/tmp/workspacecord-test-bot-startup',
    token: 'token',
    clientId: 'client',
    guildId: 'guild',
    healthReportEnabled: false,
    messageRetentionDays: 0,
    autoArchiveDays: 0,
    maxActiveSessionsPerProject: 0,
  },
}));
vi.mock('../src/commands.ts', () => ({ registerCommands }));
vi.mock('../src/project-manager.ts', () => ({ loadProjects }));
vi.mock('../src/thread-manager.ts', () => ({
  loadSessions,
  getAllSessions,
  endSession: vi.fn(),
  getSessionByChannel: vi.fn(),
}));
vi.mock('../src/archive-manager.ts', () => ({ loadArchived, checkAutoArchive: vi.fn() }));
vi.mock('../src/session-sync.ts', () => ({ startSync, stopSync }));
vi.mock('../src/health-monitor.ts', () => ({
  startHealthMonitor,
  stopHealthMonitor,
  setBotStartTime,
}));
vi.mock('../src/session-housekeeping.ts', () => ({ reconcileSessionRecordsWithGuild }));
vi.mock('../src/hook-server.ts', () => ({ startHookServer, stopHookServer }));
vi.mock('../src/hook-watcher.ts', () => ({ startHookWatcher, stopHookWatcher }));
vi.mock('../src/hook-health-check.ts', () => ({
  checkHookHealth,
  logHookHealthStatus,
  sendHookHealthNotification,
}));
vi.mock('../src/subagent-manager.ts', () => ({ runSubagentWatchdog: vi.fn() }));
vi.mock('../src/message-handler.ts', () => ({ handleMessage: vi.fn() }));
vi.mock('../src/button-handler.ts', () => ({ handleButton: vi.fn(), handleSelectMenu: vi.fn() }));
vi.mock('../src/command-handlers.ts', () => ({
  handleProject: vi.fn(),
  handleAgent: vi.fn(),
  handleSubagent: vi.fn(),
  handleShell: vi.fn(),
  handleSpawnShortcut: vi.fn(),
  handleStopShortcut: vi.fn(),
  handleEndShortcut: vi.fn(),
  handleRunShortcut: vi.fn(),
  setLogger: vi.fn(),
}));
vi.mock('../src/monitors/codex-log-monitor.ts', () => ({
  CodexLogMonitor: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock('../src/codex-monitor-bridge.ts', () => ({
  handleCodexMonitorStateChange: vi.fn(),
}));
vi.mock('../src/panel-adapter.ts', () => ({
  startPerformanceMonitoring,
  stopPerformanceMonitoring,
}));
vi.mock('../src/discord/delivery-policy.ts', () => ({ buildDeliveryPlan }));
vi.mock('../src/discord/delivery.ts', () => ({ deliver }));
vi.mock('../src/state/gate-coordinator.ts', () => ({
  gateCoordinator: {
    invalidateAllOnRestart,
    getGate: vi.fn(),
  },
}));

const { startBot } = await import('../src/bot.ts');

describe('bot startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDeliveryPlan.mockImplementation((input) => ({ sessionId: input.sessionId, chatId: input.chatId, chunks: [input.text], filesOnFirstChunk: input.files, mode: input.mode }));
    deliver.mockResolvedValue(['msg-1']);
    readyHandler = undefined;
    mkdirSync('/tmp/workspacecord-test-bot-startup', { recursive: true });
    const lockPath = '/tmp/workspacecord-test-bot-startup/bot.lock';
    if (existsSync(lockPath)) unlinkSync(lockPath);
  });


  it('启动时会先执行会话记录对账', async () => {
    await startBot();

    expect(reconcileSessionRecordsWithGuild).toHaveBeenCalledTimes(1);
    expect(reconcileSessionRecordsWithGuild).toHaveBeenCalledWith(mockGuild);
  });

  it('启动时会同时启动 hook server 与 hook watcher', async () => {
    await startBot();

    expect(startHookServer).toHaveBeenCalledTimes(1);
    expect(startHookWatcher).toHaveBeenCalledTimes(1);
  });


  it('flushLogs 通过统一投递层发送日志', async () => {
    const mod = await import('../src/bot.ts');
    await startBot();
    mod.botLog('hello log');
    await mod.flushLogs();

    expect(buildDeliveryPlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'log' }));
    expect(deliver).toHaveBeenCalled();
  });
});
