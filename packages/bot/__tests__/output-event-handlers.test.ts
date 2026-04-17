import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
const updateSessionState = vi.fn();
const queueDigest = vi.fn();
const flushDigest = vi.fn().mockResolvedValue(undefined);
const handleAwaitingHuman = vi.fn().mockResolvedValue(null);

vi.mock('@workspacecord/engine/session-registry', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()),
  getSession,
}));

vi.mock('../src/panel-adapter.ts', () => ({
  updateSessionState,
  queueDigest,
  flushDigest,
  handleAwaitingHuman,
}));

vi.mock('../src/subagent-manager.ts', () => ({
  autoSpawnSubagentThread: vi.fn().mockResolvedValue(null),
}));

vi.mock('../src/codex-renderer.ts', () => ({
  renderCommandExecutionEmbed: vi.fn(),
  renderFileChangesEmbed: vi.fn(),
  renderReasoningEmbed: vi.fn(),
  renderCodexTodoListEmbed: vi.fn(),
}));

vi.mock('../src/output/interaction-controls.ts', () => ({
  shouldSuppressCommandExecution: vi.fn(() => false),
}));

// 必须在 mock 之后 import
const { dispatchEvent } = await import('../src/output/event-handlers.ts');

function makeCtx(overrides: Partial<{ verbose: boolean; mode: string }> = {}) {
  const streamer = {
    append: vi.fn(),
    discard: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    getText: vi.fn(() => ''),
  };
  const channel = { id: 'c', type: 0, send: vi.fn(), threads: { cache: new Map() }, messages: {} };
  const state = {
    askedUser: false,
    hadError: false,
    success: null as boolean | null,
    commandCount: 0,
    fileChangeCount: 0,
    recentCommands: [] as string[],
    changedFiles: [] as string[],
    pendingAttachments: [] as string[],
    lastToolName: null as string | null,
    taskThreadMap: new Map<string, string>(),
  };
  return {
    streamer: streamer as never,
    channel: channel as never,
    sessionId: 'sess-1',
    verbose: overrides.verbose ?? false,
    mode: overrides.mode ?? 'auto',
    state,
  };
}

describe('dispatchEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockReturnValue({ id: 'sess-1', provider: 'claude' });
  });

  it('text_delta 追加到 streamer', async () => {
    const ctx = makeCtx();
    await dispatchEvent({ type: 'text_delta', text: 'hi' }, ctx);
    expect(ctx.streamer.append).toHaveBeenCalledWith('hi');
  });

  it('command_execution 累加 count 并进 digest', async () => {
    const ctx = makeCtx();
    await dispatchEvent(
      {
        type: 'command_execution',
        command: 'ls',
        output: '',
        exitCode: 0,
        status: 'done',
      },
      ctx,
    );
    expect(ctx.state.commandCount).toBe(1);
    expect(ctx.state.recentCommands).toEqual(['ls']);
    expect(queueDigest).toHaveBeenCalled();
  });

  it('file_change 累加 changedFiles 并进 digest', async () => {
    const ctx = makeCtx();
    await dispatchEvent(
      {
        type: 'file_change',
        changes: [
          { filePath: 'a.ts', changeKind: 'update' },
          { filePath: 'b.ts', changeKind: 'add' },
        ],
      },
      ctx,
    );
    expect(ctx.state.fileChangeCount).toBe(2);
    expect(ctx.state.changedFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('result 在非 monitor 模式下设置 deferredResult', async () => {
    const ctx = makeCtx({ mode: 'auto' });
    await dispatchEvent(
      {
        type: 'result',
        success: true,
        costUsd: 0.1,
        durationMs: 2000,
        numTurns: 1,
        errors: [],
      },
      ctx,
    );
    expect(ctx.state.success).toBe(true);
    expect(ctx.state.deferredResult).toBeDefined();
  });

  it('ask_user 触发 flushDigest + handleAwaitingHuman', async () => {
    const ctx = makeCtx();
    await dispatchEvent({ type: 'ask_user', questionsJson: '[]' }, ctx);
    expect(ctx.state.askedUser).toBe(true);
    expect(ctx.state.askUserQuestionsJson).toBe('[]');
    expect(flushDigest).toHaveBeenCalledWith('sess-1');
    expect(handleAwaitingHuman).toHaveBeenCalled();
  });

  it('reasoning 仅在 verbose 下进 digest', async () => {
    const quiet = makeCtx({ verbose: false });
    await dispatchEvent({ type: 'reasoning', text: 'thinking' }, quiet);
    expect(queueDigest).not.toHaveBeenCalled();

    const loud = makeCtx({ verbose: true });
    await dispatchEvent({ type: 'reasoning', text: 'thinking' }, loud);
    expect(queueDigest).toHaveBeenCalled();
  });

  it('未知事件类型不抛异常', async () => {
    const ctx = makeCtx();
    await expect(
      dispatchEvent({ type: 'unknown_type' as never } as never, ctx),
    ).resolves.not.toThrow();
  });
});
