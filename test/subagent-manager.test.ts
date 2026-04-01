import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TextChannel, ThreadChannel } from 'discord.js';
import type { ThreadSession } from '../src/types.ts';

const { createSessionMock, endSessionMock, getAllSessionsMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  endSessionMock: vi.fn(),
  getAllSessionsMock: vi.fn(() => []),
}));

vi.mock('../src/config.ts', () => ({
  config: {
    maxSubagentDepth: 3,
  },
}));

vi.mock('../src/thread-manager.ts', () => ({
  createSession: createSessionMock,
  endSession: endSessionMock,
  getAllSessions: getAllSessionsMock,
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
});
