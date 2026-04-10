import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusInitialize = vi.fn(async () => undefined);
const statusUpdate = vi.fn(async () => undefined);
const statusGetMessageId = vi.fn(() => 'status-1');
const statusAdopt = vi.fn(async () => undefined);
const statusRecreateAtBottom = vi.fn();
const sendTurnSummary = vi.fn();
const sendTurnFailure = vi.fn();
const sendEndingSummary = vi.fn();
const sendDigestSummary = vi.fn();
const relocateDigestToBottom = vi.fn();
const interactionShow = vi.fn();
const interactionHide = vi.fn();
const getSession = vi.fn();
const getSessionPermissionSummary = vi.fn();
const updateSession = vi.fn();
const setStatusCardBinding = vi.fn();
const setCurrentInteractionMessage = vi.fn();
const gateCreate = vi.fn();
const gateBindDiscordMessage = vi.fn();

vi.mock('../src/discord/status-card.ts', () => ({
  StatusCard: class {
    adopt = statusAdopt;
    initialize = statusInitialize;
    update = statusUpdate;
    getMessageId = statusGetMessageId;
    recreateAtBottom = statusRecreateAtBottom;
  },
}));

vi.mock('../src/discord/summary-handler.ts', () => ({
  SummaryHandler: class {
    sendTurnSummary = sendTurnSummary;
    sendTurnFailure = sendTurnFailure;
    sendEndingSummary = sendEndingSummary;
    sendDigestSummary = sendDigestSummary;
    relocateDigestToBottom = relocateDigestToBottom;
  },
}));

vi.mock('../src/discord/interaction-card.ts', () => ({
  InteractionCard: class {
    show = interactionShow;
    hide = interactionHide;
  },
}));

vi.mock('@workspacecord/engine/session-registry', () => ({
  getSession,
  getSessionPermissionSummary,
  updateSession,
  setStatusCardBinding,
  setCurrentInteractionMessage,
}));

vi.mock('@workspacecord/state', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    gateCoordinator: {
      createGate: gateCreate,
      bindDiscordMessage: gateBindDiscordMessage,
    },
  };
});

const {
  initializeSessionPanel,
  handleAwaitingHuman,
  handleResultEvent,
  relocateSessionPanelToBottom,
  updateSessionState,
  getStateMachine,
} = await import('../src/panel-adapter.ts');
const { stateMachine } = await import('@workspacecord/state');

function createChannel() {
  return {
    send: vi.fn(async () => ({ id: 'message-1', pin: vi.fn(async () => undefined) })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  };
}

describe('panel-adapter', () => {
  it('复用共享状态机实例', () => {
    expect(getStateMachine()).toBe(stateMachine);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 3,
      humanResolved: false,
      statusCardMessageId: undefined,
      lastInboundMessageId: 'user-msg-1',
    }));
    statusAdopt.mockResolvedValue(undefined);
    statusInitialize.mockResolvedValue(undefined);
    statusUpdate.mockResolvedValue(undefined);
    statusGetMessageId.mockReturnValue('status-1');
    statusRecreateAtBottom.mockResolvedValue({ oldMessageId: 'status-1', newMessageId: 'status-2' });
    relocateDigestToBottom.mockResolvedValue({ oldMessageIds: ['digest-1'], newMessageIds: ['digest-2'] });
    interactionShow.mockResolvedValue('interaction-1');
    gateCreate.mockReturnValue({ id: 'gate-1' });
  });

  it('失败结果使用失败总结并保留当前轮次', async () => {
    const channel = createChannel();
    await initializeSessionPanel('session-error', channel as never, { initialTurn: 3 });

    await handleResultEvent(
      'session-error',
      {
        type: 'result',
        success: false,
        costUsd: 0,
        durationMs: 10,
        numTurns: 1,
        errors: ['命令执行失败'],
      },
      '',
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(sendTurnFailure).toHaveBeenCalledWith('命令执行失败', 3, 'user-msg-1', []);
    expect(sendTurnSummary).not.toHaveBeenCalled();
    expect(statusUpdate).toHaveBeenLastCalledWith(
      'error',
      expect.objectContaining({ turn: 3 }),
    );
    expect(updateSession).not.toHaveBeenCalledWith(
      'session-error',
      expect.objectContaining({ currentTurn: 4 }),
    );
  });


  it('成功结果会推进到下一轮并回到 idle 投影', async () => {
    const channel = createChannel();
    await initializeSessionPanel('session-success', channel as never, { initialTurn: 2 });

    await handleResultEvent(
      'session-success',
      {
        type: 'result',
        success: true,
        costUsd: 0,
        durationMs: 10,
        numTurns: 1,
        errors: [],
      },
      '本轮完成',
    );

    expect(sendTurnSummary).toHaveBeenCalledWith('本轮完成', 2, 'user-msg-1', []);
    expect(statusUpdate).toHaveBeenLastCalledWith(
      'idle',
      expect.objectContaining({ turn: 3, phase: '待命' }),
    );
    expect(updateSession).toHaveBeenCalledWith(
      'session-success',
      expect.objectContaining({ currentTurn: 3, humanResolved: false }),
    );
  });

  it('会接管旧状态卡消息并保持绑定', async () => {
    const channel = createChannel();
    await initializeSessionPanel('session-adopt', channel as never, {
      statusCardMessageId: 'legacy-msg',
    });

    expect(statusAdopt).toHaveBeenCalledWith('legacy-msg');
    expect(statusInitialize).toHaveBeenCalled();
    expect(setStatusCardBinding).toHaveBeenCalledWith('session-adopt', {
      messageId: 'status-1',
    });
  });

  it('等待人工时会创建门控并透传远程审批能力', async () => {
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 1,
      humanResolved: false,
      remoteHumanControl: false,
      statusCardMessageId: undefined,
    }));
    const channel = createChannel();
    await initializeSessionPanel('session-await', channel as never, { initialTurn: 1 });

    await handleAwaitingHuman('session-await', '需要人工审批');

    expect(gateCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-await',
        provider: 'codex',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: false,
        summary: '需要人工审批',
        turn: 1,
      }),
    );
    expect(interactionShow).toHaveBeenCalledWith(
      'session-await',
      1,
      '需要人工审批',
      expect.objectContaining({
        remoteHumanControl: false,
        provider: 'codex',
      }),
    );
    expect(gateBindDiscordMessage).toHaveBeenCalledWith('gate-1', 'interaction-1');
    expect(updateSession).toHaveBeenCalledWith(
      'session-await',
      expect.objectContaining({
        activeHumanGateId: 'gate-1',
        currentInteractionMessageId: 'interaction-1',
      }),
    );
  });

  it('开始新一轮前会把状态与摘要迁移到底部并删除旧消息', async () => {
    const deleteFn = vi.fn(async () => undefined);
    const channel = {
      send: vi.fn(async () => ({ id: 'message-1' })),
      messages: {
        edit: vi.fn(async () => undefined),
        delete: deleteFn,
      },
    };
    await initializeSessionPanel('session-move', channel as never, { initialTurn: 1 });

    await relocateSessionPanelToBottom('session-move');

    expect(statusRecreateAtBottom).toHaveBeenCalled();
    expect(relocateDigestToBottom).toHaveBeenCalled();
    expect(setStatusCardBinding).toHaveBeenCalledWith('session-move', { messageId: 'status-2' });
    expect(deleteFn).toHaveBeenCalledWith('status-1');
    expect(deleteFn).toHaveBeenCalledWith('digest-1');
  });

  it('摘要迁移失败时会回滚状态消息迁移', async () => {
    const deleteFn = vi.fn(async () => undefined);
    const channel = {
      send: vi.fn(async () => ({ id: 'message-1' })),
      messages: {
        edit: vi.fn(async () => undefined),
        delete: deleteFn,
      },
    };
    await initializeSessionPanel('session-rollback', channel as never, { initialTurn: 1 });

    vi.clearAllMocks();
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 1,
      humanResolved: false,
      statusCardMessageId: 'status-1',
      lastInboundMessageId: 'user-msg-1',
    }));
    statusRecreateAtBottom.mockResolvedValue({ oldMessageId: 'status-1', newMessageId: 'status-2' });
    relocateDigestToBottom.mockRejectedValue(new Error('digest failed'));

    await relocateSessionPanelToBottom('session-rollback', channel as never);

    expect(statusAdopt).toHaveBeenCalledWith('status-1');
    expect(deleteFn).toHaveBeenCalledWith('status-2');
    expect(deleteFn).not.toHaveBeenCalledWith('status-1');
    expect(setStatusCardBinding).not.toHaveBeenCalledWith('session-rollback', {
      messageId: 'status-2',
    });
  });

  it('恢复中的会话会先接管旧状态卡再执行下移', async () => {
    const deleteFn = vi.fn(async () => undefined);
    const channel = {
      send: vi.fn(async () => ({ id: 'message-1' })),
      messages: {
        edit: vi.fn(async () => undefined),
        delete: deleteFn,
      },
    };

    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 3,
      humanResolved: false,
      statusCardMessageId: 'legacy-status',
      lastInboundMessageId: 'user-msg-1',
    }));

    await relocateSessionPanelToBottom('session-restore', channel as never);

    expect(statusAdopt).toHaveBeenCalledWith('legacy-status');
    expect(statusRecreateAtBottom).toHaveBeenCalled();
    expect(setStatusCardBinding).toHaveBeenCalledWith('session-restore', {
      messageId: 'status-2',
    });
  });

  it('并发初始化同一会话时只创建一套面板组件', async () => {
    const channel = createChannel();
    let releaseInitialize!: () => void;
    statusInitialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseInitialize = resolve;
        }),
    );

    const first = initializeSessionPanel('session-race', channel as never, { initialTurn: 1 });
    const second = initializeSessionPanel('session-race', channel as never, { initialTurn: 1 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statusInitialize).toHaveBeenCalledTimes(1);

    releaseInitialize();
    await Promise.all([first, second]);
  });

  it('初始化挂起时 relocateSessionPanelToBottom 会在 15s 超时保护后退出', async () => {
    const channel = createChannel();

    // 让 statusInitialize 永不 resolve，模拟初始化挂起
    statusInitialize.mockImplementationOnce(() => new Promise(() => {}));

    vi.useFakeTimers();
    try {
      const relocatePromise = relocateSessionPanelToBottom(
        'session-timeout',
        channel as never,
      );
      // 先挂上 rejection handler 再推进时间，避免出现短暂的 unhandled rejection
      const assertion = expect(relocatePromise).rejects.toThrow('Panel initialization timeout');

      // 推进 15s 触发超时
      await vi.advanceTimersByTimeAsync(15_001);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发执行中的 codex 会话不会被监控侧过早标记为完成', async () => {
    const channel = createChannel();
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 3,
      humanResolved: false,
      isGenerating: true,
      statusCardMessageId: undefined,
    }));

    await initializeSessionPanel('session-active', channel as never, { initialTurn: 3 });

    await updateSessionState(
      'session-active',
      {
        type: 'work_started',
        sessionId: 'session-active',
        source: 'codex',
        confidence: 'high',
        timestamp: Date.now(),
      },
      { channel: channel as never },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    vi.clearAllMocks();
    statusUpdate.mockResolvedValue(undefined);
    getSession.mockImplementation((sessionId: string) => ({
      id: sessionId,
      provider: 'codex',
      currentTurn: 3,
      humanResolved: false,
      isGenerating: true,
      statusCardMessageId: undefined,
    }));

    await updateSessionState(
      'session-active',
      {
        type: 'completed',
        sessionId: 'session-active',
        source: 'codex',
        confidence: 'high',
        timestamp: Date.now(),
      },
      { channel: channel as never, sourceHint: 'codex' },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(statusUpdate).not.toHaveBeenCalledWith(
      'completed',
      expect.anything(),
    );
  });

});
