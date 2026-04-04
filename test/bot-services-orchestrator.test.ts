import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ─── Mock dependencies ───────────────────────────────────────────────────────
const startIpcServer = vi.fn();
const stopIpcServer = vi.fn();
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
const reconcileSessionRecordsWithGuild = vi.fn(async () => ({ checkedSessions: 0, endedMissingSessions: 0 }));
const buildDeliveryPlan = vi.fn();
const deliver = vi.fn();
const startPerformanceMonitoring = vi.fn();
const stopPerformanceMonitoring = vi.fn();
const runSubagentWatchdog = vi.fn().mockResolvedValue(undefined);
const handleCodexMonitorStateChange = vi.fn();
const checkAutoArchive = vi.fn();

const invalidateAllOnRestart = vi.fn(() => []);
const cleanupExpired = vi.fn(() => 0);
const archiveResolved = vi.fn(() => 0);
const getGate = vi.fn();

let registrationCallback: ((providerSessionId: string, cwd: string, remoteHumanControl: boolean, subagent?: boolean) => Promise<boolean>) | undefined;

class MockCodexLogMonitor {
  start = vi.fn();
  stop = vi.fn();
  constructor(_baseDir: string, _stateCb: unknown, registerCb: typeof registrationCallback) {
    registrationCallback = registerCb;
  }
}

// ─── Discord mock ────────────────────────────────────────────────────────────
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
  public user = { tag: 'bot#0001', setPresence: vi.fn() };
  public guilds = { cache: { first: vi.fn(() => mockGuild) } };
  public channels = { cache: { get: vi.fn(() => undefined) } };
  on = vi.fn(() => this);
  once = vi.fn(() => this);
  login = vi.fn();
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
    dataDir: '/tmp/workspacecord-test-orchestrator',
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

vi.mock('../src/commands.ts', () => ({ registerCommands }));
vi.mock('../src/project-manager.ts', () => ({ loadProjects }));
vi.mock('../src/archive-manager.ts', () => ({ loadArchived, checkAutoArchive }));
vi.mock('../src/session-sync.ts', () => ({ startSync, stopSync }));
vi.mock('../src/health-monitor.ts', () => ({ startHealthMonitor, stopHealthMonitor, setBotStartTime }));
vi.mock('../src/session-housekeeping.ts', () => ({ reconcileSessionRecordsWithGuild }));
vi.mock('../src/ipc-server.ts', () => ({ startIpcServer, stopIpcServer }));
vi.mock('../src/subagent-manager.ts', () => ({ runSubagentWatchdog }));
vi.mock('../src/codex-monitor-bridge.ts', () => ({ handleCodexMonitorStateChange }));
vi.mock('../src/panel-adapter.ts', () => ({ startPerformanceMonitoring, stopPerformanceMonitoring }));
vi.mock('../src/discord/delivery-policy.ts', () => ({ buildDeliveryPlan }));
vi.mock('../src/discord/delivery.ts', () => ({ deliver }));
vi.mock('../src/thread-manager.ts', () => ({
  loadSessions,
  getAllSessions,
  endSession: vi.fn(),
  getSessionByChannel: vi.fn(),
  getSession: vi.fn(),
  registerLocalSession: vi.fn(),
}));
vi.mock('../src/state/gate-coordinator.ts', () => ({
  gateCoordinator: {
    invalidateAllOnRestart,
    cleanupExpired,
    archiveResolved,
    getGate,
  },
}));
vi.mock('../src/monitors/codex-log-monitor.ts', () => ({
  CodexLogMonitor: MockCodexLogMonitor,
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('BotServicesOrchestrator', () => {
  const testDir = '/tmp/workspacecord-test-orchestrator';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      chunks: [input.text],
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliver.mockResolvedValue(['msg-1']);
    registrationCallback = undefined;
    mkdirSync(testDir, { recursive: true });
    const lockPath = join(testDir, 'bot.lock');
    if (existsSync(lockPath)) unlinkSync(lockPath);
  });

  it('setupServices 注册命令、加载项目和会话', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    await orchestrator.setupServices(client as any);

    expect(registerCommands).toHaveBeenCalledTimes(1);
    expect(loadProjects).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadArchived).toHaveBeenCalledTimes(1);
  });

  it('创建或复用 bot-logs 频道', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    const container = await orchestrator.setupServices(client as any);

    expect(container.logChannel).not.toBeNull();
    expect(container.logChannel?.id).toBe('bot-logs-channel');
  });

  it('当频道已存在时复用而非创建', async () => {
    mockGuild.channels.cache.find.mockReturnValueOnce({
      id: 'existing-bot-logs',
      name: 'bot-logs',
      type: 0,
    } as any);

    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    await orchestrator.setupServices(client as any);

    expect(mockGuild.channels.create).not.toHaveBeenCalled();
  });

  it('启动时执行会话对账并记录结果', async () => {
    reconcileSessionRecordsWithGuild.mockResolvedValueOnce({ checkedSessions: 5, endedMissingSessions: 3 });

    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const container = await orchestrator.setupServices(client as any);

    expect(reconcileSessionRecordsWithGuild).toHaveBeenCalledWith(mockGuild);
    expect(container.logBuffer).toBeDefined();
    // LogBuffer should have logged the reconciliation result
    const logCalls = logSpy.mock.calls.flat().join('\n');
    expect(logCalls).toContain('Reconciled 3 stale session');
    logSpy.mockRestore();
  });

  it('设置 botStartTime 并失效待处理 gates', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    await orchestrator.setupServices(client as any);

    expect(setBotStartTime).toHaveBeenCalledTimes(1);
    expect(invalidateAllOnRestart).toHaveBeenCalledTimes(1);
  });

  it('注册 session-sync 服务并启动', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    const container = await orchestrator.setupServices(client as any);

    expect(startSync).toHaveBeenCalledWith(client);
    expect(container.serviceBus.size).toBeGreaterThan(0);
  });

  it('注册 IPC server 服务', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    await orchestrator.setupServices(client as any);

    expect(startIpcServer).toHaveBeenCalledWith(client);
  });

  it('healthReportEnabled 为 false 时不注册 health-monitor', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    await orchestrator.setupServices(client as any);

    expect(startHealthMonitor).not.toHaveBeenCalled();
  });

  it('healthReportEnabled 为 true 时注册 health-monitor', async () => {
    vi.doMock('../src/config.ts', () => ({
      config: {
        dataDir: '/tmp/workspacecord-test-orchestrator',
        token: 'token',
        clientId: 'client',
        guildId: 'guild',
        healthReportEnabled: true,
        messageRetentionDays: 0,
        autoArchiveDays: 0,
        maxActiveSessionsPerProject: 0,
        textChunkLimit: 2000,
        chunkMode: 'length',
        replyToMode: 'first',
        ackReaction: '👀',
      },
    }));
    vi.resetModules();

    // Re-import mocks after reset
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    await orchestrator.setupServices(client as any);

    expect(startHealthMonitor).toHaveBeenCalledTimes(1);
  });

  it('注册 PresenceManager 并更新 presence', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    const container = await orchestrator.setupServices(client as any);

    expect(container.presenceManager).toBeDefined();
    expect(typeof container.presenceManager.updatePresence).toBe('function');
  });

  it('返回的 ServiceContainer 包含所有必需字段', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    const container = await orchestrator.setupServices(client as any);

    expect(container).toHaveProperty('serviceBus');
    expect(container).toHaveProperty('logBuffer');
    expect(container).toHaveProperty('presenceManager');
    expect(container).toHaveProperty('logChannel');
    expect(container).toHaveProperty('codexMonitor');
  });

  it('无 guild 时 gracefully 降级', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    client.guilds.cache.first = vi.fn(() => null);
    const orchestrator = new BotServicesOrchestrator();

    const container = await orchestrator.setupServices(client as any);

    expect(container.logChannel).toBeNull();
    expect(reconcileSessionRecordsWithGuild).not.toHaveBeenCalled();
  });

  it('CodexLogMonitor 注册为服务并可 start/stop', async () => {
    const { BotServicesOrchestrator } = await import('../src/bot-services-orchestrator.ts');
    const client = new MockClient();
    const orchestrator = new BotServicesOrchestrator();

    const container = await orchestrator.setupServices(client as any);

    expect(container.codexMonitor).toBeDefined();
    // The codex-log-monitor service should be registered in serviceBus
    const services = container.serviceBus;
    expect(services.size).toBeGreaterThanOrEqual(4); // session-sync, codex-log-monitor, ipc-server, performance-monitoring
  });
});
