import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionType } from 'discord.js';

const handleProject = vi.fn();
const handleAgent = vi.fn();
const handleSubagent = vi.fn();
const handleShell = vi.fn();
const handleMessage = vi.fn();
const handleButton = vi.fn();
const handleSelectMenu = vi.fn();

vi.mock('../src/command-handlers.ts', () => ({
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  setLogger: vi.fn(),
}));
vi.mock('../src/message-handler.ts', () => ({ handleMessage }));
vi.mock('../src/button-handler.ts', () => ({ handleButton, handleSelectMenu }));
vi.mock('../src/config.ts', () => ({
  config: {
    dataDir: '/tmp/workspacecord-test',
    token: 'token',
    clientId: 'client',
    guildId: 'guild',
    healthReportEnabled: false,
    messageRetentionDays: 0,
    autoArchiveDays: 0,
    maxActiveSessionsPerProject: 0,
  },
}));
vi.mock('../src/commands.ts', () => ({ registerCommands: vi.fn() }));
vi.mock('../src/session-registry.ts', () => ({
  loadSessions: vi.fn(),
  getAllSessions: vi.fn(() => []),
  endSession: vi.fn(),
  getSessionByChannel: vi.fn(),
}));
vi.mock('../src/project-manager.ts', () => ({ loadProjects: vi.fn() }));
vi.mock('../src/subagent-manager.ts', () => ({ runSubagentWatchdog: vi.fn() }));
vi.mock('../src/archive-manager.ts', () => ({ loadArchived: vi.fn(), checkAutoArchive: vi.fn() }));
vi.mock('../src/session-sync.ts', () => ({ startSync: vi.fn(), stopSync: vi.fn() }));
vi.mock('../src/health-monitor.ts', () => ({
  startHealthMonitor: vi.fn(),
  stopHealthMonitor: vi.fn(),
  setBotStartTime: vi.fn(),
}));

const { routeInteractionCreate, routeMessageCreate } = await import('../src/bot.ts');

describe('bot routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('把 agent 命令分发到 handleAgent', async () => {
    const interaction = {
      type: InteractionType.ApplicationCommand,
      commandName: 'agent',
      isChatInputCommand: () => true,
      isButton: () => false,
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      replied: false,
      deferred: false,
      reply: vi.fn(),
    };

    await routeInteractionCreate(interaction as never);

    expect(handleAgent).toHaveBeenCalledWith(interaction);
  });

  it('把按钮交互分发到 handleButton', async () => {
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      isStringSelectMenu: () => false,
      isRepliable: () => true,
      replied: false,
      deferred: false,
      reply: vi.fn(),
    };

    await routeInteractionCreate(interaction as never);

    expect(handleButton).toHaveBeenCalledWith(interaction);
  });

  it('把下拉菜单交互分发到 handleSelectMenu', async () => {
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => false,
      isStringSelectMenu: () => true,
      isRepliable: () => true,
      replied: false,
      deferred: false,
      reply: vi.fn(),
    };

    await routeInteractionCreate(interaction as never);

    expect(handleSelectMenu).toHaveBeenCalledWith(interaction);
  });

  it('把 messageCreate 分发到 handleMessage', async () => {
    const message = { id: 'm1' };
    await routeMessageCreate(message as never);
    expect(handleMessage).toHaveBeenCalledWith(message);
  });
});
