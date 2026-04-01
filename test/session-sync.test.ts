import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const listSessions = vi.fn();
const listCodexSessionsForProjects = vi.fn();
const getAllRegisteredProjects = vi.fn();
const getAllSessions = vi.fn();
const createSession = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions,
}));

vi.mock('../src/codex-session-discovery.ts', () => ({
  listCodexSessionsForProjects,
}));

vi.mock('../src/project-registry.ts', () => ({
  getAllRegisteredProjects,
}));

vi.mock('../src/thread-manager.ts', () => ({
  getAllSessions,
  createSession,
}));

const { startSync, stopSync } = await import('../src/session-sync.ts');

describe('session-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        updatedAt: 1,
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
});
