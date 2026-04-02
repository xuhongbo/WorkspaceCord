import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';

const buildDeliveryPlan = vi.fn();
const deliver = vi.fn();
const registerLocalSession = vi.fn();
let readyHandler: (() => Promise<void> | void) | undefined;
let registrationCallback: ((providerSessionId: string, cwd: string, remoteHumanControl: boolean) => Promise<boolean>) | undefined;

vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan,
}));

vi.mock('../src/discord/delivery.ts', () => ({
  deliver,
}));

class MockClient {
  public user = { tag: 'bot#0001', setPresence: vi.fn() };
  public guilds = { cache: { first: vi.fn(() => ({ channels: { cache: { find: vi.fn(() => null) }, create: vi.fn(async () => ({ id: 'bot-logs', send: vi.fn(), messages: { fetch: vi.fn() } })) } })) } };
  public channels = { cache: { get: vi.fn((id: string) => (id === 'session-channel' ? { id, send: vi.fn() } : undefined)) } };
  on = vi.fn(() => this);
  once = vi.fn((event: string, handler: () => Promise<void> | void) => {
    if (event === 'ready') readyHandler = handler;
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
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildMessageTyping: 8 },
  ActivityType: { Custom: 1, Watching: 2 },
  InteractionType: { ApplicationCommand: 2 },
  ComponentType: {},
  ChannelType: { GuildText: 0 },
}));

vi.mock('../src/config.ts', () => ({
  config: {
    dataDir: '/tmp/workspacecord-test-bot-hint',
    token: 'token',
    clientId: 'client',
    guildId: 'guild',
    healthReportEnabled: false,
    messageRetentionDays: 0,
    autoArchiveDays: 0,
    maxActiveSessionsPerProject: 0,
    textChunkLimit: 2000,
    chunkMode: 'length',
    replyToMode: 'first',
    ackReaction: '👀',
  },
}));

vi.mock('../src/commands.ts', () => ({ registerCommands: vi.fn() }));
vi.mock('../src/project-manager.ts', () => ({ loadProjects: vi.fn() }));
vi.mock('../src/archive-manager.ts', () => ({ loadArchived: vi.fn(), checkAutoArchive: vi.fn() }));
vi.mock('../src/session-sync.ts', () => ({ startSync: vi.fn(), stopSync: vi.fn() }));
vi.mock('../src/health-monitor.ts', () => ({ startHealthMonitor: vi.fn(), stopHealthMonitor: vi.fn(), setBotStartTime: vi.fn() }));
vi.mock('../src/session-housekeeping.ts', () => ({ reconcileSessionRecordsWithGuild: vi.fn(async () => ({ checkedSessions: 0, endedMissingSessions: 0 })) }));
vi.mock('../src/hook-server.ts', () => ({ startHookServer: vi.fn(), stopHookServer: vi.fn() }));
vi.mock('../src/hook-watcher.ts', () => ({ startHookWatcher: vi.fn(), stopHookWatcher: vi.fn() }));
vi.mock('../src/hook-health-check.ts', () => ({ checkHookHealth: vi.fn(() => ({ isHealthy: true, issues: [], warnings: [] })), logHookHealthStatus: vi.fn(), sendHookHealthNotification: vi.fn() }));
vi.mock('../src/subagent-manager.ts', () => ({ runSubagentWatchdog: vi.fn() }));
vi.mock('../src/message-handler.ts', () => ({ handleMessage: vi.fn() }));
vi.mock('../src/button-handler.ts', () => ({ handleButton: vi.fn(), handleSelectMenu: vi.fn() }));
vi.mock('../src/command-handlers.ts', () => ({ handleProject: vi.fn(), handleAgent: vi.fn(), handleSubagent: vi.fn(), handleShell: vi.fn(), handleSpawnShortcut: vi.fn(), handleStopShortcut: vi.fn(), handleEndShortcut: vi.fn(), handleRunShortcut: vi.fn(), setLogger: vi.fn() }));
vi.mock('../src/codex-monitor-bridge.ts', () => ({ handleCodexMonitorStateChange: vi.fn() }));
vi.mock('../src/panel-adapter.ts', () => ({ startPerformanceMonitoring: vi.fn(), stopPerformanceMonitoring: vi.fn() }));
vi.mock('../src/state/gate-coordinator.ts', () => ({ gateCoordinator: { invalidateAllOnRestart: vi.fn(() => []), getGate: vi.fn() } }));
vi.mock('../src/thread-manager.ts', () => ({
  loadSessions: vi.fn(),
  getAllSessions: vi.fn(() => []),
  endSession: vi.fn(),
  getSessionByChannel: vi.fn(),
  registerLocalSession,
}));
vi.mock('../src/monitors/codex-log-monitor.ts', () => ({
  CodexLogMonitor: class {
    constructor(_baseDir: string, _stateCb: unknown, registerCb: typeof registrationCallback) {
      registrationCallback = registerCb;
    }
    start = vi.fn(async () => {
      await registrationCallback?.('provider-1', '/repo', false);
    });
    stop = vi.fn();
  },
}));

describe('bot unmanaged codex hint', () => {
  beforeEach(() => {
    mkdirSync('/tmp/workspacecord-test-bot-hint', { recursive: true });
    const lockPath = '/tmp/workspacecord-test-bot-hint/bot.lock';
    if (existsSync(lockPath)) unlinkSync(lockPath);
    vi.clearAllMocks();
    readyHandler = undefined;
    registrationCallback = undefined;
    buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      chunks: [input.text],
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliver.mockResolvedValue(['msg-1']);
    registerLocalSession.mockResolvedValue({
      isNewlyCreated: true,
      session: { id: 'session-1', channelId: 'session-channel', remoteHumanControl: false },
    });
  });

  it('对非受管 codex 会话通过统一投递层发送提示', async () => {
    const { startBot } = await import('../src/bot.ts');
    await startBot();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        chatId: 'session-channel',
        mode: 'system_notice',
        text: expect.stringContaining('非受管模式'),
      }),
    );
    expect(deliver).toHaveBeenCalled();
  });
});
