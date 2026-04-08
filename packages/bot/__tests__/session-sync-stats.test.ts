import { describe, expect, it, beforeEach, vi } from 'vitest';

const getAllRegisteredProjects = vi.fn();
const getAllSessions = vi.fn(() => []);
const listCodexSessionsForProjects = vi.fn();
const isArchivedProviderSession = vi.fn(() => false);
const listSessions = vi.fn(async () => []);

vi.mock('@workspacecord/engine/project-registry', () => ({ getAllRegisteredProjects }));
vi.mock('@workspacecord/engine/session-registry', () => ({ getAllSessions }));
vi.mock('../src/codex-session-discovery.ts', () => ({ listCodexSessionsForProjects }));
vi.mock('../src/archive-manager.ts', () => ({ isArchivedProviderSession }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ listSessions }));

const { runSync, getSessionSyncStats, resetSessionSyncStats } = await import('../src/session-sync.ts');

describe('session sync stats', () => {
  beforeEach(() => {
    getAllRegisteredProjects.mockReset();
    listCodexSessionsForProjects.mockReset();
    resetSessionSyncStats();
  });

  it('records noGuild when Discord client has no guild', async () => {
    getAllRegisteredProjects.mockReturnValue([
      { discordCategoryId: 'cat-1', path: '/repo' },
    ]);

    const client = {
      guilds: { cache: { first: () => undefined } },
    } as unknown as Parameters<typeof runSync>[0];

    await runSync(client);

    const stats = getSessionSyncStats();
    expect(stats.skipReasons.noGuild).toBe(1);
    expect(stats.runs).toBe(1);
  });

  it('records noProjects when no Discord projects are registered', async () => {
    getAllRegisteredProjects.mockReturnValue([]);
    const client = {
      guilds: { cache: { first: () => ({ channels: { cache: new Map() } }) } },
    } as unknown as Parameters<typeof runSync>[0];

    await runSync(client);

    const stats = getSessionSyncStats();
    expect(stats.skipReasons.noProjects).toBe(1);
    expect(stats.runs).toBe(1);
  });
});
