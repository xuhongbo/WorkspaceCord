import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelType } from 'discord.js';
import { _setDataDirForTest } from '../src/persistence.ts';

const getProject = vi.fn();
const setHistoryChannelId = vi.fn();
const endSession = vi.fn();
const getAllSessions = vi.fn();
const getSessionsByCategory = vi.fn();

vi.mock('../src/project-manager.ts', () => ({
  getProject,
  setHistoryChannelId,
}));

vi.mock('../src/thread-manager.ts', () => ({
  endSession,
  getAllSessions,
  getSessionsByCategory,
}));

vi.mock('../src/config.ts', () => ({
  config: {
    autoArchiveDays: 0,
    maxActiveSessionsPerProject: 0,
  },
}));

describe('archive-manager', () => {
  let dataDir = '';

  beforeEach(() => {
    vi.clearAllMocks();
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-archive-'));
    _setDataDirForTest(dataDir);
    getProject.mockReturnValue({
      categoryId: 'cat-1',
      historyChannelId: 'history-1',
    });
    getAllSessions.mockReturnValue([]);
    getSessionsByCategory.mockReturnValue([]);
    endSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('归档会写入 providerSessionId 并允许按 provider 会话查询', async () => {
    const archiveManager = await import('../src/archive-manager.ts');
    await archiveManager.loadArchived();

    const createPost = vi.fn(async () => ({ id: 'post-1' }));
    const deleteChannel = vi.fn(async () => undefined);
    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => {
            if (id === 'history-1') {
              return {
                id: 'history-1',
                type: ChannelType.GuildForum,
                threads: {
                  create: createPost,
                },
              };
            }
            if (id === 'channel-1') {
              return {
                id: 'channel-1',
                delete: deleteChannel,
              };
            }
            return undefined;
          }),
          find: vi.fn(() => undefined),
        },
        create: vi.fn(),
      },
    };

    await archiveManager.archiveSession(
      {
        id: 'session-1',
        channelId: 'channel-1',
        categoryId: 'cat-1',
        projectName: 'demo',
        agentLabel: 'demo-session',
        provider: 'codex',
        providerSessionId: 'provider-1',
        directory: '/repo',
        type: 'persistent',
        subagentDepth: 0,
        mode: 'auto',
        verbose: false,
        workflowState: { status: 'idle', iteration: 0, updatedAt: 1 },
        isGenerating: false,
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        totalCost: 0,
        currentTurn: 0,
        humanResolved: false,
      },
      guild as never,
      'manual archive',
    );

    const archived = archiveManager.getArchivedSessions('cat-1');
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      provider: 'codex',
      providerSessionId: 'provider-1',
      summary: 'manual archive',
    });
    expect(archiveManager.isArchivedProviderSession?.('codex', 'provider-1')).toBe(true);
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(deleteChannel).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith('session-1');
  });
});
