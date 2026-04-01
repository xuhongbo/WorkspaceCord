import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const updateSession = vi.fn();
const executeSessionContinue = vi.fn();
const executeSessionPrompt = vi.fn();
const updateSessionState = vi.fn();
const getGate = vi.fn();
const getActiveGateForSession = vi.fn();
const resolveFromDiscord = vi.fn();
const getCleanupRequest = vi.fn();
const deleteCleanupRequest = vi.fn();
const acquireCleanupLock = vi.fn();
const releaseCleanupLock = vi.fn();
const archiveSessionsById = vi.fn();

vi.mock('../src/config.ts', () => ({
  config: {
    allowedUsers: [],
    allowAllUsers: true,
  },
}));

vi.mock('../src/utils.ts', () => ({
  isUserAllowed: () => true,
  truncate: (text: string) => text,
}));

vi.mock('../src/thread-manager.ts', () => ({
  getSession,
  updateSession,
  abortSession: vi.fn(() => false),
  setMode: vi.fn(),
}));

vi.mock('../src/output-handler.ts', () => ({
  getExpandableContent: vi.fn(),
  makeModeButtons: vi.fn(() => []),
  setPendingAnswer: vi.fn(),
  getPendingAnswers: vi.fn(),
  clearPendingAnswers: vi.fn(),
  getQuestionCount: vi.fn(() => 0),
}));

vi.mock('../src/session-executor.ts', () => ({
  executeSessionContinue,
  executeSessionPrompt,
}));

vi.mock('../src/panel-adapter.ts', () => ({
  updateSessionState,
}));
vi.mock('../src/agent-cleanup-request-store.ts', () => ({
  getCleanupRequest,
  deleteCleanupRequest,
  acquireCleanupLock,
  releaseCleanupLock,
}));
vi.mock('../src/session-housekeeping.ts', () => ({
  archiveSessionsById,
}));

vi.mock('../src/state/gate-coordinator.ts', () => ({
  gateCoordinator: {
    getGate,
    getActiveGateForSession,
    resolveFromDiscord,
  },
}));

const { handleButton } = await import('../src/button-handler.ts');

function createInteraction(customId: string) {
  return {
    customId,
    user: { id: 'u1', tag: 'tester#1000' },
    channel: { id: 'c1', send: vi.fn(), messages: {} },
    message: { id: 'msg-active', embeds: [{ title: '等待人工处理' }] },
    reply: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

describe('button-handler awaiting_human', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockReturnValue({
      id: 's1',
      currentTurn: 2,
      humanResolved: false,
      provider: 'codex',
      activeHumanGateId: 'gate-1',
      currentInteractionMessageId: 'msg-active',
    });
    getGate.mockReturnValue({ id: 'gate-1', status: 'pending' });
    getActiveGateForSession.mockReturnValue(undefined);
    resolveFromDiscord.mockResolvedValue({ success: true });
    getCleanupRequest.mockReturnValue(undefined);
    deleteCleanupRequest.mockReturnValue(true);
    acquireCleanupLock.mockReturnValue(true);
    archiveSessionsById.mockResolvedValue({
      archivedSessions: 1,
      skippedGenerating: 0,
      missingSessions: 0,
      failed: [],
    });
  });

  it('approve 会清理交互状态、同步状态并继续会话', async () => {
    const interaction = createInteraction('awaiting_human:s1:2:approve');

    await handleButton(interaction as never);

    expect(updateSession).toHaveBeenCalledWith('s1', {
      humanResolved: true,
      currentInteractionMessageId: undefined,
      activeHumanGateId: undefined,
    });
    expect(updateSessionState).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'human_resolved', source: 'codex' }),
    );
    expect(executeSessionContinue).toHaveBeenCalled();
  });

  it('deny 会清理交互状态并回落到 idle，不继续会话', async () => {
    const interaction = createInteraction('awaiting_human:s1:2:deny');

    await handleButton(interaction as never);

    expect(updateSession).toHaveBeenCalledWith('s1', {
      humanResolved: true,
      currentInteractionMessageId: undefined,
      activeHumanGateId: undefined,
    });
    expect(updateSessionState).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ type: 'session_idle', source: 'codex' }),
    );
    expect(executeSessionContinue).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it('当前消息不是有效交互消息时拒绝处理', async () => {
    const interaction = createInteraction('awaiting_human:s1:2:approve');
    interaction.message.id = 'msg-stale';

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '此请求已过期（消息不匹配）', ephemeral: true }),
    );
    expect(executeSessionContinue).not.toHaveBeenCalled();
    expect(updateSessionState).not.toHaveBeenCalled();
  });

  it('旧问题卡按钮已废弃，返回提示', async () => {
    const interaction = createInteraction('answer:s1:0:Yes');

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '⚠️ 此交互方式已废弃，请使用最新的交互卡',
        ephemeral: true,
      }),
    );
    expect(updateSession).not.toHaveBeenCalled();
    expect(updateSessionState).not.toHaveBeenCalled();
    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });

  it('cleanup cancel 会删除请求并更新消息', async () => {
    getCleanupRequest.mockReturnValue({
      id: 'cleanup-1',
      userId: 'u1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'current-1',
      candidateSessionIds: ['session-1'],
      createdAt: Date.now(),
    });
    const interaction = createInteraction('cleanup:cancel:cleanup-1');

    await handleButton(interaction as never);

    expect(deleteCleanupRequest).toHaveBeenCalledWith('cleanup-1');
    expect(interaction.update).toHaveBeenCalledWith({
      content: '本次批量清理已取消。',
      components: [],
    });
  });

  it('cleanup confirm 会调用批量归档并释放锁', async () => {
    getCleanupRequest.mockReturnValue({
      id: 'cleanup-1',
      userId: 'u1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'current-1',
      candidateSessionIds: ['session-1'],
      createdAt: Date.now(),
    });
    const interaction = createInteraction('cleanup:confirm:cleanup-1');
    interaction.guild = { id: 'guild-1' };

    await handleButton(interaction as never);

    expect(acquireCleanupLock).toHaveBeenCalledWith('cat-1');
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(archiveSessionsById).toHaveBeenCalledWith(
      interaction.guild,
      ['session-1'],
      'Bulk cleanup from Discord command',
    );
    expect(deleteCleanupRequest).toHaveBeenCalledWith('cleanup-1');
    expect(releaseCleanupLock).toHaveBeenCalledWith('cat-1');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('批量清理完成'),
        components: [],
      }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it('cleanup confirm 在请求过期时提示重新执行', async () => {
    const interaction = createInteraction('cleanup:confirm:cleanup-missing');

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '这次清理请求已失效，请重新执行 /agent cleanup。',
      ephemeral: true,
    });
    expect(archiveSessionsById).not.toHaveBeenCalled();
  });

  it('cleanup confirm 在非发起人点击时拒绝处理', async () => {
    getCleanupRequest.mockReturnValue({
      id: 'cleanup-1',
      userId: 'owner-1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'current-1',
      candidateSessionIds: ['session-1'],
      createdAt: Date.now(),
    });
    const interaction = createInteraction('cleanup:confirm:cleanup-1');

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '只有发起这次清理的人可以确认或取消。',
      ephemeral: true,
    });
    expect(archiveSessionsById).not.toHaveBeenCalled();
  });

  it('cleanup confirm 在项目已加锁时拒绝重复执行', async () => {
    getCleanupRequest.mockReturnValue({
      id: 'cleanup-1',
      userId: 'u1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'current-1',
      candidateSessionIds: ['session-1'],
      createdAt: Date.now(),
    });
    acquireCleanupLock.mockReturnValue(false);
    const interaction = createInteraction('cleanup:confirm:cleanup-1');
    interaction.guild = { id: 'guild-1' };

    await handleButton(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '当前项目正在执行批量清理，请稍后再试。',
      ephemeral: true,
    });
    expect(archiveSessionsById).not.toHaveBeenCalled();
    expect(releaseCleanupLock).not.toHaveBeenCalled();
  });
});
