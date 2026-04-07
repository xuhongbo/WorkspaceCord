import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextChannel, ThreadChannel } from 'discord.js';
import type { ThreadSession } from '../src/types.ts';

const { createSessionMock, endSessionMock, getAllSessionsMock, sendSystemNoticeMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  endSessionMock: vi.fn(),
  getAllSessionsMock: vi.fn(() => []),
  sendSystemNoticeMock: vi.fn(),
}));

vi.mock('../src/config.ts', () => ({
  config: {
    maxSubagentDepth: 3,
  },
}));

vi.mock('../src/session-registry.ts', () => ({
  createSession: createSessionMock,
  endSession: endSessionMock,
  getAllSessions: getAllSessionsMock,
}));

vi.mock('../src/discord/delivery-notices.ts', () => ({
  sendSystemNotice: sendSystemNoticeMock,
}));

function makeParentSession(
  overrides: Partial<ThreadSession> = {},
): ThreadSession {
  return {
    id: 'parent-session',
    channelId: 'parent-channel',
    categoryId: 'cat-1',
    projectName: 'demo',
    agentLabel: 'parent',
    provider: 'claude',
    type: 'persistent',
    subagentDepth: 0,
    directory: '/repo',
    mode: 'auto',
    verbose: false,
    claudePermissionMode: 'bypass',
    workflowState: {
      status: 'idle',
      iteration: 0,
      updatedAt: 1,
    },
    isGenerating: false,
    createdAt: 1,
    lastActivity: 1,
    messageCount: 0,
    totalCost: 0,
    currentTurn: 0,
    humanResolved: false,
    ...overrides,
  };
}

describe('subagent-manager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('Claude 子代理会继承父会话权限模式', async () => {
    const thread = { id: 'thread-1' } as ThreadChannel;
    const sessionChannel = {
      threads: {
        create: vi.fn().mockResolvedValue(thread),
      },
    } as unknown as TextChannel;
    createSessionMock.mockResolvedValue(
      makeParentSession({
        channelId: 'thread-1',
        type: 'subagent',
        parentChannelId: 'parent-channel',
        subagentDepth: 1,
      }),
    );

    const { spawnSubagent } = await import('../src/subagent-manager.ts');
    await spawnSubagent(makeParentSession(), 'worker', 'claude', sessionChannel);

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        claudePermissionMode: 'bypass',
      }),
    );
  });

  it('非 Claude 子代理不会携带 Claude 权限模式', async () => {
    const thread = { id: 'thread-2' } as ThreadChannel;
    const sessionChannel = {
      threads: {
        create: vi.fn().mockResolvedValue(thread),
      },
    } as unknown as TextChannel;
    createSessionMock.mockResolvedValue(
      makeParentSession({
        channelId: 'thread-2',
        type: 'subagent',
        provider: 'codex',
        parentChannelId: 'parent-channel',
        subagentDepth: 1,
      }),
    );

    const { spawnSubagent } = await import('../src/subagent-manager.ts');
    await spawnSubagent(makeParentSession(), 'worker', 'codex', sessionChannel);

    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        claudePermissionMode: undefined,
      }),
    );
  });

  it('canSpawnSubagent 在深度低于最大值时返回 true', async () => {
    const { canSpawnSubagent } = await import('../src/subagent-manager.ts');
    expect(canSpawnSubagent(makeParentSession({ subagentDepth: 0 }))).toBe(true);
    expect(canSpawnSubagent(makeParentSession({ subagentDepth: 2 }))).toBe(true);
  });

  it('canSpawnSubagent 在深度达到最大值时返回 false', async () => {
    const { canSpawnSubagent } = await import('../src/subagent-manager.ts');
    expect(canSpawnSubagent(makeParentSession({ subagentDepth: 3 }))).toBe(false);
    expect(canSpawnSubagent(makeParentSession({ subagentDepth: 5 }))).toBe(false);
  });

  it('spawnSubagent 在深度受限时抛出错误', async () => {
    const { spawnSubagent } = await import('../src/subagent-manager.ts');
    const sessionChannel = { threads: { create: vi.fn() } } as unknown as TextChannel;
    const parent = makeParentSession({ subagentDepth: 3 });

    await expect(
      spawnSubagent(parent, 'test', 'claude', sessionChannel),
    ).rejects.toThrow('Max subagent depth (3) reached');
    expect(sessionChannel.threads.create).not.toHaveBeenCalled();
  });

  it('spawnSubagent 截断过长的线程名称至 100 字符', async () => {
    const thread = { id: 'thread-3' } as ThreadChannel;
    const sessionChannel = {
      threads: { create: vi.fn().mockResolvedValue(thread) },
    } as unknown as TextChannel;
    createSessionMock.mockResolvedValue(makeParentSession({
      channelId: 'thread-3', type: 'subagent', subagentDepth: 1,
    }));

    const { spawnSubagent } = await import('../src/subagent-manager.ts');
    const longLabel = 'x'.repeat(200);
    await spawnSubagent(makeParentSession(), longLabel, 'codex', sessionChannel);

    const name = sessionChannel.threads.create.mock.calls[0][0].name;
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it('archiveSubagent 发送摘要、归档线程并结束会话', async () => {
    const { archiveSubagent } = await import('../src/subagent-manager.ts');
    const session = makeParentSession({
      id: 'sub-1', type: 'subagent', channelId: 'thread-arch',
    });
    const thread = {
      id: 'thread-arch',
      setArchived: vi.fn(async () => {}),
    } as unknown as ThreadChannel;

    await archiveSubagent(session, thread, 'Task done');

    expect(sendSystemNoticeMock).toHaveBeenCalledWith(
      thread, 'sub-1', '*Subagent complete: Task done*',
    );
    expect(thread.setArchived).toHaveBeenCalledWith(true, 'Subagent task completed');
    expect(endSessionMock).toHaveBeenCalledWith('sub-1');
  });

  it('archiveSubagent 在归档失败时仍能结束会话', async () => {
    const { archiveSubagent } = await import('../src/subagent-manager.ts');
    const session = makeParentSession({
      id: 'sub-2', type: 'subagent', channelId: 'thread-fail',
    });
    const thread = {
      id: 'thread-fail',
      setArchived: vi.fn(async () => { throw new Error('perm denied'); }),
    } as unknown as ThreadChannel;

    await expect(archiveSubagent(session, thread)).resolves.not.toThrow();
    expect(endSessionMock).toHaveBeenCalledWith('sub-2');
  });

  it('getSubagents 仅返回匹配父频道的子代理', async () => {
    const { getSubagents } = await import('../src/subagent-manager.ts');
    const sub1 = makeParentSession({ id: 's1', type: 'subagent', parentChannelId: 'ch-1', channelId: 't1' });
    const sub2 = makeParentSession({ id: 's2', type: 'subagent', parentChannelId: 'ch-1', channelId: 't2' });
    const persistent = makeParentSession({ id: 'p1', type: 'persistent', channelId: 'ch-1' });
    const otherSub = makeParentSession({ id: 's3', type: 'subagent', parentChannelId: 'ch-99', channelId: 't3' });

    getAllSessionsMock.mockReturnValue([sub1, sub2, persistent, otherSub]);

    const parent = makeParentSession({ channelId: 'ch-1' });
    const result = getSubagents(parent);

    expect(result).toHaveLength(2);
    expect(result.map(s => s.id)).toEqual(expect.arrayContaining(['s1', 's2']));
  });

  it('runSubagentWatchdog 归档空闲超时的子代理', async () => {
    const { runSubagentWatchdog } = await import('../src/subagent-manager.ts');
    const idleTime = Date.now() - (60 * 60 * 1000 + 1000);
    const idleSub = makeParentSession({
      id: 'idle-1', type: 'subagent', channelId: 'thread-idle',
      lastActivity: idleTime, isGenerating: false,
    });
    getAllSessionsMock.mockReturnValue([idleSub]);

    const mockThread = { id: 'thread-idle', setArchived: vi.fn(async () => {}) };
    const getThread = vi.fn((id: string) => id === 'thread-idle' ? mockThread : undefined);

    await runSubagentWatchdog(getThread);

    expect(mockThread.setArchived).toHaveBeenCalled();
    expect(endSessionMock).toHaveBeenCalledWith('idle-1');
  });

  it('runSubagentWatchdog 跳过正在生成的子代理', async () => {
    const { runSubagentWatchdog } = await import('../src/subagent-manager.ts');
    const busySub = makeParentSession({
      id: 'busy-1', type: 'subagent', channelId: 'thread-busy',
      lastActivity: Date.now() - (60 * 60 * 1000 + 1000), isGenerating: true,
    });
    getAllSessionsMock.mockReturnValue([busySub]);

    const getThread = vi.fn(() => undefined);
    await runSubagentWatchdog(getThread);

    expect(getThread).not.toHaveBeenCalled();
    expect(endSessionMock).not.toHaveBeenCalled();
  });

  it('runSubagentWatchdog 结束线程已丢失的孤儿子代理', async () => {
    const { runSubagentWatchdog } = await import('../src/subagent-manager.ts');
    const orphanSub = makeParentSession({
      id: 'orphan-1', type: 'subagent', channelId: 'thread-orphan',
      lastActivity: Date.now() - (60 * 60 * 1000 + 1000), isGenerating: false,
    });
    getAllSessionsMock.mockReturnValue([orphanSub]);
    endSessionMock.mockResolvedValue(undefined);

    const getThread = vi.fn(() => undefined);
    await runSubagentWatchdog(getThread);

    expect(endSessionMock).toHaveBeenCalledWith('orphan-1');
  });
});
