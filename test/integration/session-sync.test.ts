import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

const listSessions = vi.fn();
const listCodexSessionsForProjects = vi.fn();
const getAllRegisteredProjects = vi.fn();
const getAllSessions = vi.fn();
const createSession = vi.fn();
const getSession = vi.fn();
const endSession = vi.fn();
const isArchivedProviderSession = vi.fn();
const configMock = {
  sessionSyncIntervalMs: 30_000,
  sessionSyncRecentDays: 3,
};

vi.mock('../../src/config.ts', () => ({
  config: configMock,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions,
}));

vi.mock('../../src/codex-session-discovery.ts', () => ({
  listCodexSessionsForProjects,
}));

vi.mock('../../src/project-registry.ts', () => ({
  getAllRegisteredProjects,
}));

vi.mock('../../src/session-registry.ts', () => ({
  getAllSessions,
  getSession,
  createSession,
  endSession,
}));

vi.mock('../../src/archive-manager.ts', () => ({
  isArchivedProviderSession,
}));

const { startSync, stopSync, runSync } = await import('../../src/session-sync.ts');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCategory(id: string) {
  return {
    id,
    type: ChannelType.GuildCategory,
    children: {
      cache: {
        find: vi.fn().mockReturnValue(undefined),
      },
    },
  };
}

function makeGuild(categories: Array<{ id: string }>) {
  const categoryMap = new Map(categories.map((c) => [c.id, makeCategory(c.id)]));
  return {
    channels: {
      cache: {
        get: vi.fn((id: string) => categoryMap.get(id)),
      },
      create: vi.fn(async (payload: Record<string, unknown>) => ({
        id: `created-${Math.random().toString(16).slice(2, 8)}`,
        name: payload.name,
        parentId: payload.parent,
        type: payload.type ?? ChannelType.GuildText,
      })),
    },
  };
}

function makeClient(guild: ReturnType<typeof makeGuild>) {
  return {
    guilds: {
      cache: {
        first: vi.fn(() => guild),
      },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('session-sync integration: discovery and sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.sessionSyncRecentDays = 3;
  });

  afterEach(() => {
    stopSync();
    vi.restoreAllMocks();
  });

  it('Claude SDK session discovery triggers in-memory session update', async () => {
    listSessions.mockResolvedValue([
      {
        sessionId: 'claude-disc-1',
        summary: 'Discover Claude session',
        firstPrompt: 'Discover Claude session',
        lastModified: Date.now(),
      },
    ]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(false);
    listCodexSessionsForProjects.mockReturnValue([]);

    const guild = makeGuild([{ id: 'cat-1' }]);
    const client = makeClient(guild);

    await runSync(client as Parameters<typeof runSync>[0]);

    expect(listSessions).toHaveBeenCalledWith({ dir: '/repo', limit: 50 });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'claude-disc-1',
        provider: 'claude',
        directory: '/repo',
        type: 'persistent',
        discoverySource: 'sync',
      }),
    );
  });

  it('Codex session discovery triggers in-memory session update', async () => {
    listSessions.mockResolvedValue([]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(false);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-disc-1',
        threadName: 'Discover Codex session',
        updatedAt: Date.now(),
        cwd: '/repo/packages/app',
        projectPath: '/repo',
      },
    ]);

    const guild = makeGuild([{ id: 'cat-1' }]);
    const client = makeClient(guild);

    await runSync(client as Parameters<typeof runSync>[0]);

    expect(listCodexSessionsForProjects).toHaveBeenCalledWith(['/repo']);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        providerSessionId: 'codex-disc-1',
        provider: 'codex',
        directory: '/repo/packages/app',
        type: 'persistent',
        discoverySource: 'sync',
      }),
    );
  });

  it('sync adds new sessions then cleans up orphan channels via cleanupSessionsById', async () => {
    // Before sync: 1 existing session
    getAllSessions.mockReturnValue([
      {
        id: 'existing-session',
        channelId: 'existing-channel',
        providerSessionId: 'existing-ps',
        provider: 'claude',
        type: 'persistent',
      },
    ]);
    getAllRegisteredProjects.mockReturnValue([
      { name: 'repo', path: '/repo', discordCategoryId: 'cat-1' },
    ]);
    isArchivedProviderSession.mockReturnValue(false);

    // Sync discovers 2 new sessions
    listSessions.mockResolvedValue([
      {
        sessionId: 'claude-new-1',
        summary: 'New Claude session',
        firstPrompt: 'New Claude session',
        lastModified: Date.now(),
      },
    ]);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-new-1',
        threadName: 'New Codex session',
        updatedAt: Date.now(),
        cwd: '/repo',
        projectPath: '/repo',
      },
    ]);
    createSession.mockResolvedValue(undefined);

    const guild = makeGuild([{ id: 'cat-1' }]);
    const client = makeClient(guild);

    await runSync(client as Parameters<typeof runSync>[0]);

    // Both new sessions should be created
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerSessionId: 'claude-new-1' }),
    );
    expect(createSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerSessionId: 'codex-new-1' }),
    );
  });

  it('multi-project concurrent sync discovers sessions across projects', async () => {
    listSessions.mockImplementation(async ({ dir }: { dir: string }) => {
      if (dir === '/project-alpha') {
        return [
          {
            sessionId: 'alpha-session-1',
            summary: 'Alpha session',
            firstPrompt: 'Alpha session',
            lastModified: Date.now(),
          },
        ];
      }
      if (dir === '/project-beta') {
        return [
          {
            sessionId: 'beta-session-1',
            summary: 'Beta session',
            firstPrompt: 'Beta session',
            lastModified: Date.now(),
          },
        ];
      }
      return [];
    });
    getAllRegisteredProjects.mockReturnValue([
      { name: 'alpha', path: '/project-alpha', discordCategoryId: 'cat-alpha' },
      { name: 'beta', path: '/project-beta', discordCategoryId: 'cat-beta' },
    ]);
    getAllSessions.mockReturnValue([]);
    createSession.mockResolvedValue(undefined);
    isArchivedProviderSession.mockReturnValue(false);
    listCodexSessionsForProjects.mockReturnValue([
      {
        id: 'codex-alpha-1',
        threadName: 'Codex alpha',
        updatedAt: Date.now(),
        cwd: '/project-alpha',
        projectPath: '/project-alpha',
      },
      {
        id: 'codex-beta-1',
        threadName: 'Codex beta',
        updatedAt: Date.now(),
        cwd: '/project-beta',
        projectPath: '/project-beta',
      },
    ]);

    const guild = makeGuild([{ id: 'cat-alpha' }, { id: 'cat-beta' }]);
    const client = makeClient(guild);

    await runSync(client as Parameters<typeof runSync>[0]);

    // 2 Claude + 2 Codex sessions = 4 total
    expect(createSession).toHaveBeenCalledTimes(4);

    const calls = createSession.mock.calls;
    const providerSessionIds = calls.map((c: Array<Record<string, string>>) => c[0].providerSessionId);
    expect(providerSessionIds).toContain('alpha-session-1');
    expect(providerSessionIds).toContain('beta-session-1');
    expect(providerSessionIds).toContain('codex-alpha-1');
    expect(providerSessionIds).toContain('codex-beta-1');
  });
});
