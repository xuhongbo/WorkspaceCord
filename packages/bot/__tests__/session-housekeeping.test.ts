import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const endSession = vi.fn();
const getAllSessions = vi.fn();
const archiveSession = vi.fn();

vi.mock('@workspacecord/engine/session-registry', () => ({
  getSession,
  endSession,
  getAllSessions,
}));
vi.mock('../src/archive-manager.ts', () => ({
  archiveSession,
}));

const {
  archiveSessionsById,
  buildProjectCleanupPreview,
  cleanupSessionsById,
  reconcileSessionRecordsWithGuild,
} = await import(
  '../src/session-housekeeping.ts'
);

function makeGuild(channels: Record<string, { id: string; delete: ReturnType<typeof vi.fn> } | null>) {
  return {
    channels: {
      cache: {
        get: vi.fn((id: string) => channels[id] ?? undefined),
      },
      fetch: vi.fn(async (id: string) => channels[id] ?? null),
    },
  };
}

describe('session-housekeeping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('buildProjectCleanupPreview 仅返回当前项目下可归档的空闲主会话', () => {
    getAllSessions.mockReturnValue([
      {
        id: 'keep-current',
        channelId: 'current',
        categoryId: 'cat-1',
        type: 'persistent',
        isGenerating: false,
        agentLabel: 'current',
        lastActivity: 10,
      },
      {
        id: 'keep-control',
        channelId: 'control-1',
        categoryId: 'cat-1',
        type: 'persistent',
        isGenerating: false,
        agentLabel: 'control',
        lastActivity: 20,
      },
      {
        id: 'skip-running',
        channelId: 'run-1',
        categoryId: 'cat-1',
        type: 'persistent',
        isGenerating: true,
        agentLabel: 'running',
        lastActivity: 30,
      },
      {
        id: 'archive-idle',
        channelId: 'idle-1',
        categoryId: 'cat-1',
        type: 'persistent',
        isGenerating: false,
        agentLabel: 'idle',
        lastActivity: 5,
      },
      {
        id: 'other-category',
        channelId: 'idle-2',
        categoryId: 'cat-2',
        type: 'persistent',
        isGenerating: false,
        agentLabel: 'other',
        lastActivity: 1,
      },
      {
        id: 'subagent',
        channelId: 'thread-1',
        categoryId: 'cat-1',
        type: 'subagent',
        isGenerating: false,
        agentLabel: 'sub',
        lastActivity: 40,
      },
    ]);

    const preview = buildProjectCleanupPreview({
      categoryId: 'cat-1',
      currentChannelId: 'current',
      controlChannelId: 'control-1',
      historyChannelId: 'history-1',
      projectName: 'demo',
    });

    expect(preview.categoryId).toBe('cat-1');
    expect(preview.projectName).toBe('demo');
    expect(preview.archiveCandidates.map((session) => session.id)).toEqual(['archive-idle']);
    expect(preview.skippedGenerating.map((session) => session.id)).toEqual(['skip-running']);
    expect(preview.skippedUnknown.map((session) => session.id)).toEqual([]);
  });

  it('deletes existing channels and ends matching sessions', async () => {
    const deleteChannel = vi.fn(async () => undefined);
    const guild = makeGuild({
      'channel-1': { id: 'channel-1', delete: deleteChannel },
    });
    getSession.mockReturnValue({ id: 'session-1', channelId: 'channel-1' });
    endSession.mockResolvedValue(undefined);

    const result = await cleanupSessionsById(
      guild as never,
      ['session-1'],
      'cleanup smoke sessions',
    );

    expect(deleteChannel).toHaveBeenCalledWith('cleanup smoke sessions');
    expect(endSession).toHaveBeenCalledWith('session-1');
    expect(result).toEqual(
      expect.objectContaining({
        deletedChannels: 1,
        missingChannels: 0,
        endedSessions: 1,
      }),
    );
  });

  it('ends sessions even when the Discord channel is already missing', async () => {
    const guild = makeGuild({});
    getSession.mockReturnValue({ id: 'session-2', channelId: 'channel-2' });
    endSession.mockResolvedValue(undefined);

    const result = await cleanupSessionsById(guild as never, ['session-2']);

    expect(endSession).toHaveBeenCalledWith('session-2');
    expect(result).toEqual(
      expect.objectContaining({
        deletedChannels: 0,
        missingChannels: 1,
        endedSessions: 1,
      }),
    );
  });

  it('reconciles persisted sessions whose channels no longer exist', async () => {
    const deleteChannel = vi.fn(async () => undefined);
    const guild = makeGuild({
      'channel-1': { id: 'channel-1', delete: deleteChannel },
      'channel-2': null,
    });
    getAllSessions.mockReturnValue([
      { id: 'session-1', channelId: 'channel-1' },
      { id: 'session-2', channelId: 'channel-2' },
    ]);
    endSession.mockResolvedValue(undefined);

    const result = await reconcileSessionRecordsWithGuild(guild as never);

    expect(endSession).toHaveBeenCalledTimes(1);
    expect(endSession).toHaveBeenCalledWith('session-2');
    expect(result).toEqual({ checkedSessions: 2, endedMissingSessions: 1 });
  });

  it('archiveSessionsById 归档空闲会话、跳过进行中并记录失败', async () => {
    const guild = makeGuild({});
    getSession.mockImplementation((id: string) => {
      if (id === 'idle-1') {
        return {
          id: 'idle-1',
          channelId: 'channel-1',
          type: 'persistent',
          isGenerating: false,
        };
      }
      if (id === 'run-1') {
        return {
          id: 'run-1',
          channelId: 'channel-2',
          type: 'persistent',
          isGenerating: true,
        };
      }
      if (id === 'fail-1') {
        return {
          id: 'fail-1',
          channelId: 'channel-3',
          type: 'persistent',
          isGenerating: false,
        };
      }
      return undefined;
    });
    archiveSession
      .mockResolvedValueOnce({ id: 'idle-1' })
      .mockRejectedValueOnce(new Error('archive failed'));

    const result = await archiveSessionsById(guild as never, ['idle-1', 'run-1', 'fail-1', 'missing-1']);

    expect(archiveSession).toHaveBeenCalledTimes(2);
    expect(archiveSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'idle-1' }),
      guild,
      'Bulk cleanup from Discord command',
    );
    expect(result).toEqual({
      archivedSessions: 1,
      skippedGenerating: 1,
      missingSessions: 1,
      failed: [
        {
          sessionId: 'fail-1',
          channelId: 'channel-3',
          message: 'archive failed',
        },
      ],
    });
  });
});
