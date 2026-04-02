import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusInitialize = vi.fn(async () => undefined);
const statusUpdate = vi.fn(async () => undefined);
const statusGetMessageId = vi.fn(() => 'status-1');
const statusAdopt = vi.fn(async () => undefined);
const sendTurnSummary = vi.fn();
const sendTurnFailure = vi.fn();
const sendEndingSummary = vi.fn();
const sendDigestSummary = vi.fn();
const interactionShow = vi.fn();
const interactionHide = vi.fn();
const getSession = vi.fn();
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
  },
}));

vi.mock('../src/discord/summary-handler.ts', () => ({
  SummaryHandler: class {
    sendTurnSummary = sendTurnSummary;
    sendTurnFailure = sendTurnFailure;
    sendEndingSummary = sendEndingSummary;
    sendDigestSummary = sendDigestSummary;
  },
}));

vi.mock('../src/discord/interaction-card.ts', () => ({
  InteractionCard: class {
    show = interactionShow;
    hide = interactionHide;
  },
}));

vi.mock('../src/thread-manager.ts', () => ({
  getSession,
  updateSession,
  setStatusCardBinding,
  setCurrentInteractionMessage,
}));

vi.mock('../src/state/gate-coordinator.ts', () => ({
  gateCoordinator: {
    createGate: gateCreate,
    bindDiscordMessage: gateBindDiscordMessage,
  },
}));

const { initializeSessionPanel, handleAwaitingHuman, handleResultEvent } = await import('../src/panel-adapter.ts');

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

});
