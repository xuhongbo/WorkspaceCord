import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleOutputStream = vi.fn();
const getSession = vi.fn();
const setMonitorGoal = vi.fn();
const updateWorkflowState = vi.fn();
const sendPrompt = vi.fn();
const continueSession = vi.fn();
const continueSessionWithOverrides = vi.fn();
const sendMonitorPrompt = vi.fn();
const consumeAbortReason = vi.fn();
const updateSessionState = vi.fn();
const queueDigest = vi.fn();
const handleResultEvent = vi.fn();
const handleAwaitingHuman = vi.fn();
const registerReceiptHandle = vi.fn();

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/core')>();
  return {
    ...actual,
    config: {
      claudePermissionMode: 'normal',
    },
  };
});

vi.mock('../src/output-port.ts', () => ({
  getOutputPort: () => ({
    handleOutputStream,
    updateState: updateSessionState,
    handleResult: handleResultEvent,
    handleAwaitingHuman,
    queueDigest,
    flushDigest: vi.fn(),
    initializePanel: vi.fn(),
    relocatePanel: vi.fn(),
    cleanupPanel: vi.fn(),
    getProjection: vi.fn(() => ({})),
  }),
}));

vi.mock('../src/session-registry.ts', () => ({
  getSession,
  setMonitorGoal,
  updateWorkflowState,
  consumeAbortReason,
  abortSessionWithReason: vi.fn(),
}));
vi.mock('../src/session/provider-runtime.ts', () => ({
  sendPrompt,
  continueSession,
  continueSessionWithOverrides,
  sendMonitorPrompt,
}));

vi.mock('@workspacecord/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/state')>();
  return {
    ...actual,
    gateCoordinator: {
      registerReceiptHandle,
    },
  };
});
const { executeSessionPrompt, executeSessionContinue } = await import('../src/session-executor.ts');

describe('executeSessionPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('persists the first monitor goal from the initial prompt', async () => {
    const session = {
      id: 'monitor-1',
      mode: 'monitor',
      monitorGoal: undefined,
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Completed the requested change.',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 1,
      fileChangeCount: 3,
      recentCommands: [],
      changedFiles: ['src/file.ts'],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          status: 'complete',
          confidence: 'high',
          rationale: 'Done',
          steering: '',
          completionSummary: 'Done',
          acceptedEvidence: ['Completed the requested change.'],
          missingEvidence: [],
          requiredNextProof: [],
          disallowedDrift: [],
          blockingReason: '',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = {
      send: vi.fn().mockResolvedValue(undefined),
    };

    await executeSessionPrompt(
      session as Parameters<typeof executeSessionPrompt>[0],
      channel as Parameters<typeof executeSessionPrompt>[1],
      'Fix the failing workflow.',
    );

    expect(setMonitorGoal).toHaveBeenCalledWith('monitor-1', 'Fix the failing workflow.');
  });

  it('monitor 完成时通过 panel-adapter 收尾而不是直接发频道消息', async () => {
    const session = {
      id: 'monitor-2',
      mode: 'monitor',
      monitorGoal: 'Fix the failing workflow.',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Completed the requested change.',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 1,
      fileChangeCount: 1,
      recentCommands: [],
      changedFiles: ['src/file.ts'],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          status: 'complete',
          confidence: 'high',
          rationale: 'Done',
          steering: '',
          completionSummary: 'Done',
          acceptedEvidence: ['Completed the requested change.'],
          missingEvidence: [],
          requiredNextProof: [],
          disallowedDrift: [],
          blockingReason: '',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    await executeSessionPrompt(session as never, channel as never, 'Fix the failing workflow.');

    expect(handleResultEvent).toHaveBeenCalled();
    const call = handleResultEvent.mock.calls.at(-1);
    expect(call?.[0]).toBe('monitor-2');
    expect(call?.[2]).toBe('Done');
    expect(channel.send).not.toHaveBeenCalledWith(expect.stringContaining('Monitor: completion bar met'));
  });

  it('monitor 认为 ask_user 需要人工时会挂出交互卡', async () => {
    const session = {
      id: 'monitor-ask',
      mode: 'monitor',
      monitorGoal: 'Finish the task',
      provider: 'codex',
      activeHumanGateId: 'gate-ask-1',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Need human input',
      askedUser: true,
      askUserQuestionsJson: JSON.stringify({ questions: [{ question: 'Continue?' }] }),
      hadError: false,
      success: true,
      commandCount: 0,
      fileChangeCount: 0,
      recentCommands: [],
      changedFiles: [],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          shouldAskHuman: true,
          rationale: 'Human approval required.',
          autoResponse: '',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    await executeSessionPrompt(session as never, channel as never, 'Finish the task');

    expect(handleAwaitingHuman).toHaveBeenCalledWith(
      'monitor-ask',
      JSON.stringify({ questions: [{ question: 'Continue?' }] }),
      expect.objectContaining({ source: 'codex' }),
    );
    expect(registerReceiptHandle).toHaveBeenCalledWith(
      'gate-ask-1',
      expect.objectContaining({
        type: 'codex',
        sessionId: 'monitor-ask',
      }),
    );
  });

  it('monitor 判断 blocked 时会挂出交互卡', async () => {
    const session = {
      id: 'monitor-blocked',
      mode: 'monitor',
      monitorGoal: 'Finish the task',
      provider: 'codex',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    handleOutputStream.mockResolvedValue({
      text: 'Worker stalled',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 1,
      fileChangeCount: 1,
      recentCommands: [],
      changedFiles: ['src/file.ts'],
    });
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          status: 'blocked',
          confidence: 'high',
          rationale: 'Need human help',
          steering: '',
          completionSummary: '',
          acceptedEvidence: [],
          missingEvidence: ['Manual decision'],
          requiredNextProof: ['Human decision'],
          disallowedDrift: [],
          blockingReason: 'Need human help',
        }),
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    await executeSessionPrompt(session as never, channel as never, 'Finish the task');

    expect(handleAwaitingHuman).toHaveBeenCalledWith(
      'monitor-blocked',
      'Need human help',
      expect.objectContaining({ source: 'codex' }),
    );
  });

  it('非 monitor 模式下 continue 会真正调用继续执行链路', async () => {
    const session = {
      id: 'normal-continue',
      mode: 'normal',
      monitorGoal: undefined,
      provider: 'claude',
      workflowState: { status: 'idle', iteration: 1, updatedAt: Date.now() },
    };

    getSession.mockImplementation(() => session);
    continueSessionWithOverrides.mockImplementation(async function* () {
      yield {
        type: 'result',
        success: true,
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        errors: [],
      };
    });
    handleOutputStream.mockResolvedValue({
      text: 'continued',
      askedUser: false,
      hadError: false,
      success: true,
      commandCount: 0,
      fileChangeCount: 0,
      recentCommands: [],
      changedFiles: [],
    });
    consumeAbortReason.mockReturnValue(undefined);

    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    await executeSessionContinue(session as never, channel as never);

    expect(continueSessionWithOverrides).toHaveBeenCalledWith(
      'normal-continue',
      expect.objectContaining({
        canUseTool: expect.any(Function),
      }),
    );
    expect(handleOutputStream).toHaveBeenCalled();
  });
});

describe('non-monitor executeSessionPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('auto mode runs a single worker pass and returns', async () => {
    const session = {
      id: 'auto-1', mode: 'auto' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'hello');

    expect(sendPrompt).toHaveBeenCalledWith('auto-1', 'hello', expect.any(Object));
    expect(sendMonitorPrompt).not.toHaveBeenCalled();
  });

  it('plan mode runs a single worker pass', async () => {
    const session = {
      id: 'plan-1', mode: 'plan' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'fix bug');

    expect(sendPrompt).toHaveBeenCalled();
  });

  it('normal mode runs a single worker pass', async () => {
    const session = {
      id: 'normal-1', mode: 'normal' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'refactor');

    expect(sendPrompt).toHaveBeenCalled();
  });
});

describe('monitor mode edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('monitor mode with empty prompt falls back to single worker pass', async () => {
    const session = {
      id: 'mon-no-goal', mode: 'monitor' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, '');

    expect(sendPrompt).toHaveBeenCalled();
    expect(sendMonitorPrompt).not.toHaveBeenCalled();
  });

  it('monitor mode aborts early when abortReason is user', async () => {
    const session = {
      id: 'mon-abort-user', mode: 'monitor' as const, provider: 'claude' as const,
      monitorGoal: 'fix it',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: 'aborted' };
    });
    handleOutputStream.mockResolvedValue({
      text: 'session was aborted by user', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: [],
    });
    consumeAbortReason.mockReturnValue('user');

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'fix it');

    expect(sendMonitorPrompt).not.toHaveBeenCalled();
  });

  it('monitor mode aborts early when text contains abort pattern', async () => {
    const session = {
      id: 'mon-abort-text', mode: 'monitor' as const, provider: 'claude' as const,
      monitorGoal: 'fix it',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: 'cancelled' };
    });
    handleOutputStream.mockResolvedValue({
      text: 'Request was cancelled by user', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: [],
    });
    consumeAbortReason.mockReturnValue('user');

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'fix it');

    expect(sendMonitorPrompt).not.toHaveBeenCalled();
  });
});

describe('Claude permission handler options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
  });

  it('permission handler is passed to provider for normal mode claude sessions', async () => {
    const session = {
      id: 'perm-normal', mode: 'normal' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'write a file');

    expect(sendPrompt).toHaveBeenCalledWith(
      'perm-normal',
      'write a file',
      expect.objectContaining({ canUseTool: expect.any(Function) }),
    );
  });

  it('permission handler is NOT passed for auto mode sessions', async () => {
    const session = {
      id: 'perm-auto', mode: 'auto' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'write a file');

    const options = sendPrompt.mock.calls[0][2];
    expect(options.canUseTool).toBeUndefined();
  });

  it('permission handler is NOT passed for codex provider', async () => {
    const session = {
      id: 'perm-codex', mode: 'normal' as const, provider: 'codex' as const,
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'done', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'write a file');

    const options = sendPrompt.mock.calls[0][2];
    expect(options.canUseTool).toBeUndefined();
  });
});

describe('executeSessionContinue non-monitor mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
  });

  it('normal mode continue calls continueSessionWithOverrides', async () => {
    const session = {
      id: 'cont-normal', mode: 'normal' as const, provider: 'claude' as const,
      workflowState: { status: 'idle' as const, iteration: 1, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    continueSessionWithOverrides.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'continued', askedUser: false, hadError: false, success: true,
      commandCount: 0, fileChangeCount: 0, recentCommands: [], changedFiles: [],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionContinue(session as never, { send: vi.fn() } as never);

    expect(continueSessionWithOverrides).toHaveBeenCalledWith(
      'cont-normal',
      expect.objectContaining({ canUseTool: expect.any(Function) }),
    );
  });

  it('auto mode continue does NOT pass canUseTool', async () => {
    const session = {
      id: 'cont-auto', mode: 'auto' as const, provider: 'codex' as const,
      workflowState: { status: 'idle' as const, iteration: 1, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);
    continueSessionWithOverrides.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'continued', askedUser: false, hadError: false, success: true,
      commandCount: 0, fileChangeCount: 0, recentCommands: [], changedFiles: [],
    });
    consumeAbortReason.mockReturnValue(undefined);

    await executeSessionContinue(session as never, { send: vi.fn() } as never);

    const options = continueSessionWithOverrides.mock.calls[0][1];
    expect(options.canUseTool).toBeUndefined();
  });
});

describe('executeSessionContinue monitor mode no goal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
  });

  it('monitor continue with no goal blocks and reports error', async () => {
    const session = {
      id: 'cont-mon-no-goal', mode: 'monitor' as const, provider: 'claude' as const,
      monitorGoal: undefined,
      workflowState: { status: 'idle' as const, iteration: 1, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    await executeSessionContinue(session as never, { send: vi.fn() } as never);

    expect(handleResultEvent).toHaveBeenCalled();
    const resultCall = handleResultEvent.mock.calls.at(-1);
    expect(resultCall?.[1].success).toBe(false);
    expect(handleAwaitingHuman).toHaveBeenCalled();
  });
});

describe('monitor loop: max iterations reached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('stops after max iterations and reports blocked', async () => {
    const session = {
      id: 'mon-max', mode: 'monitor' as const, provider: 'codex' as const,
      monitorGoal: 'refactor everything',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    // Worker produces minimal output (no text, no files) so classifyWorkerPassForContinuation returns "continue"
    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: '' };
    });
    handleOutputStream.mockResolvedValue({
      text: '', askedUser: false, hadError: false, success: true,
      commandCount: 0, fileChangeCount: 0, recentCommands: [], changedFiles: [],
    });
    consumeAbortReason.mockReturnValue(undefined);

    // Monitor always says "continue" so the loop runs to max
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({
          status: 'continue', confidence: 'high', rationale: 'keep going',
          steering: 'keep going', completionSummary: '', acceptedEvidence: [],
          missingEvidence: ['more work'], requiredNextProof: ['do more'],
          disallowedDrift: [], blockingReason: '',
        }),
      };
    });

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'refactor everything');

    expect(handleResultEvent).toHaveBeenCalled();
    const resultCall = handleResultEvent.mock.calls.at(-1);
    expect(resultCall?.[1].success).toBe(false);
    expect(handleAwaitingHuman).toHaveBeenCalled();
  });
});

describe('classifyWorkerPassForContinuation: error path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('worker pass with error triggers pre-classified continue and retry', async () => {
    const session = {
      id: 'class-error', mode: 'monitor' as const, provider: 'codex' as const,
      monitorGoal: 'fix the bug',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: 'error happened' };
    });
    handleOutputStream.mockResolvedValue({
      text: 'Error: something failed', askedUser: false, hadError: true, success: false,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/file.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    // Second worker pass (after pre-classified retry), then monitor says complete
    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({
          status: 'complete', confidence: 'high', rationale: 'fixed after retry',
          steering: '', completionSummary: 'fixed', acceptedEvidence: ['fixed'],
          missingEvidence: [], requiredNextProof: [], disallowedDrift: [], blockingReason: '',
        }),
      };
    });

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'fix the bug');

    expect(queueDigest).toHaveBeenCalledWith(
      'class-error',
      expect.objectContaining({ kind: 'monitor' }),
    );
  });
});

describe('classifyWorkerPassForContinuation: no text and no file changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('worker pass with no text and no file changes triggers pre-classified continue', async () => {
    const session = {
      id: 'class-empty', mode: 'monitor' as const, provider: 'codex' as const,
      monitorGoal: 'implement feature',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: '' };
    });
    handleOutputStream.mockResolvedValue({
      text: '', askedUser: false, hadError: false, success: true,
      commandCount: 0, fileChangeCount: 0, recentCommands: [], changedFiles: [],
    });
    consumeAbortReason.mockReturnValue(undefined);

    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({
          status: 'complete', confidence: 'high', rationale: 'done now',
          steering: '', completionSummary: 'done', acceptedEvidence: ['done'],
          missingEvidence: [], requiredNextProof: [], disallowedDrift: [], blockingReason: '',
        }),
      };
    });

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'implement feature');

    expect(queueDigest).toHaveBeenCalledWith(
      'class-empty',
      expect.objectContaining({ kind: 'monitor' }),
    );
  });
});

describe('monitor decision parse failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('falls back to continue when monitor returns invalid JSON', async () => {
    const session = {
      id: 'mon-invalid-json', mode: 'monitor' as const, provider: 'codex' as const,
      monitorGoal: 'do it',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: 'working' };
    });
    handleOutputStream.mockResolvedValue({
      text: 'working', askedUser: false, hadError: false, success: true,
      commandCount: 2, fileChangeCount: 3, recentCommands: [], changedFiles: ['a.ts', 'b.ts', 'c.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    sendMonitorPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: 'not json at all' };
    });

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'do it');

    expect(sendMonitorPrompt).toHaveBeenCalled();
  });

  it('falls back to continue when monitor returns invalid status', async () => {
    const session = {
      id: 'mon-invalid-status', mode: 'monitor' as const, provider: 'codex' as const,
      monitorGoal: 'do it',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: 'working' };
    });
    handleOutputStream.mockResolvedValue({
      text: 'working', askedUser: false, hadError: false, success: true,
      commandCount: 2, fileChangeCount: 3, recentCommands: [], changedFiles: ['a.ts', 'b.ts', 'c.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({ status: 'unknown_status', confidence: 'high', rationale: 'hmm' }),
      };
    });

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'do it');

    expect(sendMonitorPrompt).toHaveBeenCalled();
  });
});

describe('executeSessionContinue with nextProofContract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('uses sendPrompt with steering prompt when nextProofContract exists', async () => {
    const session = {
      id: 'cont-contract', mode: 'monitor' as const, provider: 'claude' as const,
      monitorGoal: 'build the feature',
      workflowState: {
        status: 'retrying' as const, iteration: 2, updatedAt: Date.now(),
        nextProofContract: {
          goal: 'build the feature', acceptedEvidence: ['unit tests pass'],
          missingEvidence: ['integration tests'], requiredNextProof: ['run integration tests'],
          requiredArtifacts: ['test-results.json'], requiredValidation: ['pnpm test:integration'],
          stopCondition: 'all tests pass', avoidUntilProved: ['refactoring unrelated files'],
        },
        lastMonitorDecision: {
          status: 'continue' as const, confidence: 'high' as const, rationale: 'need more tests',
          steering: 'write tests', completionSummary: '', acceptedEvidence: ['unit tests pass'],
          missingEvidence: ['integration tests'], requiredNextProof: ['run integration tests'],
          disallowedDrift: ['refactoring unrelated files'], blockingReason: '',
        },
      },
    };
    getSession.mockReturnValue(session);

    sendPrompt.mockImplementation(async function* () {
      yield { type: 'result' as const, success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    handleOutputStream.mockResolvedValue({
      text: 'tests pass now', askedUser: false, hadError: false, success: true,
      commandCount: 1, fileChangeCount: 1, recentCommands: [], changedFiles: ['src/test.ts'],
    });
    consumeAbortReason.mockReturnValue(undefined);

    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({
          status: 'complete', confidence: 'high', rationale: 'all tests pass',
          steering: '', completionSummary: 'tests done', acceptedEvidence: ['tests pass now'],
          missingEvidence: [], requiredNextProof: [], disallowedDrift: [], blockingReason: '',
        }),
      };
    });

    await executeSessionContinue(session as never, { send: vi.fn() } as never);

    expect(sendPrompt).toHaveBeenCalled();
  });
});

describe('normalizeMonitorDecision overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleResultEvent.mockResolvedValue(undefined);
    updateSessionState.mockResolvedValue(undefined);
    handleAwaitingHuman.mockResolvedValue('msg-1');
    registerReceiptHandle.mockImplementation((_gateId: string, handle: { resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void }) => {
      handle.resolve('approve', 'discord');
    });
  });

  it('downgrades complete to continue when worker has no text and weak execution', async () => {
    const session = {
      id: 'normalize-downgrade', mode: 'monitor' as const, provider: 'codex' as const,
      monitorGoal: 'do it',
      workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    };
    getSession.mockReturnValue(session);

    sendPrompt.mockImplementation(async function* () {
      yield { type: 'text_delta' as const, text: '' };
    });

    // Track call count to return different worker results
    let workerCallCount = 0;
    handleOutputStream.mockImplementation(async () => {
      workerCallCount++;
      if (workerCallCount === 1) {
        // First pass: weak output (triggers downgrade from complete -> continue)
        return {
          text: '', askedUser: false, hadError: false, success: true,
          commandCount: 1, fileChangeCount: 2, changedFiles: ['a.ts', 'b.ts'], recentCommands: [],
        };
      }
      // Second pass: strong output that completes successfully
      return {
        text: 'all done now', askedUser: false, hadError: false, success: true,
        commandCount: 3, fileChangeCount: 5, changedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], recentCommands: [],
      };
    });
    consumeAbortReason.mockReturnValue(undefined);

    sendMonitorPrompt.mockImplementation(async function* () {
      yield {
        type: 'text_delta' as const,
        text: JSON.stringify({
          status: 'complete', confidence: 'high', rationale: 'looks done',
          steering: '', completionSummary: '', acceptedEvidence: [],
          missingEvidence: [], requiredNextProof: [], disallowedDrift: [], blockingReason: '',
        }),
      };
    });

    await executeSessionPrompt(session as never, { send: vi.fn() } as never, 'do it');

    // First worker pass was weak -> monitor was called -> complete was downgraded to continue
    // -> triggered second worker pass with steering prompt -> second pass was strong enough
    // -> monitor called again -> complete accepted
    expect(sendMonitorPrompt).toHaveBeenCalled();
    // The queueDigest should show monitor continued (not completed on first pass)
    expect(queueDigest).toHaveBeenCalledWith(
      'normalize-downgrade',
      expect.objectContaining({ kind: 'monitor' }),
    );
  });
});
