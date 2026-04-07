import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const getProject = vi.fn();
const setHistoryChannelId = vi.fn();
const setControlChannelId = vi.fn();
const createSession = vi.fn();
const getSessionByChannel = vi.fn();
const getSession = vi.fn();
const setMode = vi.fn();
const updateSessionPermissions = vi.fn();
const getSessionPermissionSummary = vi.fn(() => 'normal');
const getSessionPermissionDetails = vi.fn(() => 'Claude: normal');

vi.mock('../src/config.ts', () => ({
  config: {
    allowedUsers: [],
    allowAllUsers: true,
    defaultProvider: 'claude',
    defaultMode: 'auto',
    claudePermissionMode: 'normal',
  },
}));

vi.mock('../src/utils.ts', () => ({
  isUserAllowed: () => true,
  resolvePath: (value: string) => value,
  formatUptime: () => '1m',
  formatRelative: () => 'just now',
}));

vi.mock('../src/project-manager.ts', () => ({
  getProject,
  setHistoryChannelId,
  setControlChannelId,
  bindMountedProjectToCategory: vi.fn(),
  setPersonality: vi.fn(),
  clearPersonality: vi.fn(),
  addSkill: vi.fn(),
  removeSkill: vi.fn(),
  getSkills: vi.fn(() => []),
  executeSkill: vi.fn(),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  getMcpServers: vi.fn(() => []),
}));

vi.mock('../src/session-registry.ts', () => ({
  createSession,
  getSession,
  getSessionByChannel,
  getSessionsByCategory: vi.fn(() => []),
  setMode,
  updateSessionPermissions,
  getSessionPermissionSummary,
  getSessionPermissionDetails,
  abortSession: vi.fn(() => false),
  endSession: vi.fn(),
  setMonitorGoal: vi.fn(),
  setAgentPersona: vi.fn(),
  setVerbose: vi.fn(),
  setModel: vi.fn(),
}));

vi.mock('../src/subagent-manager.ts', () => ({
  spawnSubagent: vi.fn(),
  getSubagents: vi.fn(() => []),
}));

vi.mock('../src/archive-manager.ts', () => ({
  archiveSession: vi.fn(),
}));

vi.mock('../src/session-executor.ts', () => ({
  executeSessionPrompt: vi.fn(),
  executeSessionContinue: vi.fn(),
}));

vi.mock('../src/output-handler.ts', () => ({
  makeModeButtons: vi.fn(() => []),
  resolveEffectiveClaudePermissionMode: vi.fn(() => 'normal'),
}));

vi.mock('../src/shell-handler.ts', () => ({
  executeShellCommand: vi.fn(),
  listProcesses: vi.fn(() => []),
  killProcess: vi.fn(() => false),
}));

const { handleAgent, handleProject } = await import('../src/command-handlers.ts');

function makeOptions(subcommand: string, values: Record<string, string | null | undefined>) {
  return {
    getSubcommand: () => subcommand,
    getString: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required option: ${name}`);
      }
      return value ?? null;
    },
  };
}

function makeInteraction(args: {
  channel: {
    id: string;
    name?: string;
    parentId?: string | null;
    type?: ChannelType;
    isThread?: () => boolean;
    send?: ReturnType<typeof vi.fn>;
  };
  guild: {
    channels: {
      cache: {
        get: ReturnType<typeof vi.fn>;
        find: ReturnType<typeof vi.fn>;
      };
      create: ReturnType<typeof vi.fn>;
    };
  };
  subcommand: string;
  values: Record<string, string | null | undefined>;
}) {
  const reply = vi.fn(async (payload) => payload);
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async (payload) => payload);

  return {
    user: { id: 'user-1', tag: 'tester#0001' },
    guild: args.guild,
    channel: {
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(async () => undefined),
      ...args.channel,
    },
    channelId: args.channel.id,
    options: makeOptions(args.subcommand, args.values),
    reply,
    deferReply,
    editReply,
  };
}

describe('command-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('在 project setup 时把当前频道记录为控制频道', async () => {
    const bindMountedProjectToCategory = (await import('../src/project-manager.ts'))
      .bindMountedProjectToCategory as unknown as ReturnType<typeof vi.fn>;
    bindMountedProjectToCategory.mockResolvedValue({
      name: 'demo',
      directory: '/repo',
      historyChannelId: undefined,
      controlChannelId: undefined,
    });

    const historyForum = { id: 'forum-1' };
    const guild = {
      channels: {
        cache: {
          get: vi.fn(() => ({ id: 'cat-1', name: 'Demo Category' })),
          find: vi.fn(() => undefined),
        },
        create: vi.fn(async ({ type }: { type: ChannelType }) => {
          if (type === ChannelType.GuildForum) return historyForum;
          throw new Error('unexpected create');
        }),
      },
    };

    const interaction = makeInteraction({
      guild,
      channel: { id: 'control-1', name: 'control', parentId: 'cat-1' },
      subcommand: 'setup',
      values: { project: 'demo' },
    });

    await handleProject(interaction as never);

    expect(setHistoryChannelId).toHaveBeenCalledWith('cat-1', 'forum-1');
    expect(setControlChannelId).toHaveBeenCalledWith('cat-1', 'control-1');
  });

  it('当在已有会话频道中执行 agent spawn 时会重定向到专用控制频道', async () => {
    getProject.mockReturnValue({
      categoryId: 'cat-1',
      name: 'demo',
      directory: '/repo',
      historyChannelId: 'forum-1',
      controlChannelId: undefined,
      skills: [],
      mcpServers: [],
      createdAt: 1,
    });
    getSessionByChannel.mockReturnValue({ id: 'existing-session', channelId: 'session-1' });

    const controlChannel = { id: 'control-1', name: 'control', parentId: 'cat-1' };
    const guild = {
      channels: {
        cache: {
          get: vi.fn(() => undefined),
          find: vi.fn(() => undefined),
        },
        create: vi.fn(async ({ type }: { type: ChannelType }) => {
          if (type === ChannelType.GuildText) return controlChannel;
          throw new Error('unexpected create');
        }),
      },
    };

    const interaction = makeInteraction({
      guild,
      channel: { id: 'session-1', name: 'claude-bugfix', parentId: 'cat-1' },
      subcommand: 'spawn',
      values: { label: 'test' },
    });

    await handleAgent(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(setControlChannelId).toHaveBeenCalledWith('cat-1', 'control-1');
    expect(createSession).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('<#control-1>'),
    );
  });
});
