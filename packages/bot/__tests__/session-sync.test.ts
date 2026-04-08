import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const listSessions = vi.fn();
const listCodexSessionsForProjects = vi.fn();
const getAllRegisteredProjects = vi.fn();
const getAllSessions = vi.fn();
const createSession = vi.fn();
const isArchivedProviderSession = vi.fn();
const configMock = {
  sessionSyncIntervalMs: 30_000,
  sessionSyncRecentDays: 3,
};

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    config: configMock,
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions,
}));

vi.mock('../src/codex-session-discovery.ts', () => ({
  listCodexSessionsForProjects,
}));

vi.mock('@workspacecord/engine/project-registry', () => ({
  getAllRegisteredProjects,
}));

vi.mock('@workspacecord/engine/session-registry', () => ({
  getAllSessions,
  createSession,
}));

vi.mock('../src/archive-manager.ts', () => ({
  isArchivedProviderSession,
}));

const { startSync, stopSync } = await import('../src/session-sync.ts');

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.sessionSyncRecentDays = 3;
  });

  afterEach(() => {
    stopSync();
  });

  it('creates synced Codex sessions with the discovered working directory', async () => {
    listSessions.mockResolvedValue([]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-1',
        threadName: 'Investigate package issue',
        updatedAt: Date.now(),
        cwd: '/repo/packages/app',
        projectPath: '/repo',
      },
    ]);

    const category = {
      id: 'cat-1',
      type: ChannelType.GuildCategory,
      children: {
        cache: {
          find: vi.fn().mockReturnValue(undefined),
        },
      },
    };

    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => (id === 'cat-1' ? category : undefined)),
        },
        create: vi.fn().mockResolvedValue({ id: 'channel-1' }),
      },
    };

    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };

    startSync(client as Parameters<typeof startSync>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSync();

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: '/repo/packages/app',
      }),
    );
  });

  it('skips rebuilding provider sessions that were already archived', async () => {
    listSessions.mockResolvedValue([]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(true);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-archived-1',
        threadName: 'Old archived session',
        updatedAt: Date.now(),
        cwd: '/repo',
        projectPath: '/repo',
      },
    ]);

    const category = {
      id: 'cat-1',
      type: ChannelType.GuildCategory,
      children: {
        cache: {
          find: vi.fn().mockReturnValue(undefined),
        },
      },
    };

    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => (id === 'cat-1' ? category : undefined)),
        },
        create: vi.fn().mockResolvedValue({ id: 'channel-1' }),
      },
    };

    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };

    startSync(client as Parameters<typeof startSync>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSync();

    expect(isArchivedProviderSession).toHaveBeenCalledWith('codex', 'codex-archived-1');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('skips syncing Codex sessions whose last activity is older than three days', async () => {
    listSessions.mockResolvedValue([]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(false);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-old-1',
        threadName: 'Old codex session',
        updatedAt: Date.now() - 4 * 24 * 60 * 60 * 1000,
        cwd: '/repo',
        projectPath: '/repo',
      },
    ]);

    const category = {
      id: 'cat-1',
      type: ChannelType.GuildCategory,
      children: {
        cache: {
          find: vi.fn().mockReturnValue(undefined),
        },
      },
    };

    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => (id === 'cat-1' ? category : undefined)),
        },
        create: vi.fn().mockResolvedValue({ id: 'channel-1' }),
      },
    };

    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };

    startSync(client as Parameters<typeof startSync>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSync();

    expect(createSession).not.toHaveBeenCalled();
  });

  it('skips syncing Claude sessions whose last activity is older than three days', async () => {
    listSessions.mockResolvedValue([
      {
        sessionId: 'claude-old-1',
        summary: 'Old claude session',
        firstPrompt: 'Old claude session',
        lastModified: Date.now() - 4 * 24 * 60 * 60 * 1000,
      },
    ]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(false);
    listCodexSessionsForProjects.mockReturnValue([]);

    const category = {
      id: 'cat-1',
      type: ChannelType.GuildCategory,
      children: {
        cache: {
          find: vi.fn().mockReturnValue(undefined),
        },
      },
    };

    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => (id === 'cat-1' ? category : undefined)),
        },
        create: vi.fn().mockResolvedValue({ id: 'channel-1' }),
      },
    };

    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };

    startSync(client as Parameters<typeof startSync>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSync();

    expect(createSession).not.toHaveBeenCalled();
  });

  it('allows syncing older sessions when the recent-days window is disabled', async () => {
    configMock.sessionSyncRecentDays = 0;

    listSessions.mockResolvedValue([]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(false);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-old-allowed-1',
        threadName: 'Allowed old codex session',
        updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
        cwd: '/repo',
        projectPath: '/repo',
      },
    ]);

    const category = {
      id: 'cat-1',
      type: ChannelType.GuildCategory,
      children: {
        cache: {
          find: vi.fn().mockReturnValue(undefined),
        },
      },
    };

    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => (id === 'cat-1' ? category : undefined)),
        },
        create: vi.fn().mockResolvedValue({ id: 'channel-1' }),
      },
    };

    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };

    startSync(client as Parameters<typeof startSync>[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stopSync();

    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'codex-old-allowed-1',
      }),
    );
  });
});
