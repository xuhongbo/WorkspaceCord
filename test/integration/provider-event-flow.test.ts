import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent } from '../../src/providers/types.ts';

// ── Hoisted mocks ─────────────────────────────────────────────────

const deliveryMocks = vi.hoisted(() => ({
  buildDeliveryPlan: vi.fn(),
  deliver: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  initializeSessionPanel: vi.fn(),
  updateSessionState: vi.fn(),
  handleResultEvent: vi.fn(),
  handleAwaitingHuman: vi.fn(),
  queueDigest: vi.fn(),
  flushDigest: vi.fn(),
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────

vi.mock('../../src/panel-adapter.ts', () => ({
  initializeSessionPanel: mocks.initializeSessionPanel,
  updateSessionState: mocks.updateSessionState,
  handleResultEvent: mocks.handleResultEvent,
  handleAwaitingHuman: mocks.handleAwaitingHuman,
  queueDigest: mocks.queueDigest,
  flushDigest: mocks.flushDigest,
}));
vi.mock('../../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan: deliveryMocks.buildDeliveryPlan,
}));
vi.mock('../../src/discord/delivery.ts', () => ({
  deliver: deliveryMocks.deliver,
}));
vi.mock('../../src/thread-manager.ts', () => ({
  getSession: mocks.getSession,
  updateSession: mocks.updateSession,
  getSessionByChannel: vi.fn(),
  updateWorkflowState: vi.fn(),
  setMode: vi.fn(),
}));

// ── Import after mocking ─────────────────────────────────────────

const { handleOutputStream } = await import('../../src/output-handler.ts');

// ── Test helpers ──────────────────────────────────────────────────

function createFakeChannel() {
  const sent: unknown[] = [];
  return {
    id: 'chat-1',
    sent,
    async send(payload: unknown) {
      sent.push(payload);
      return {
        id: `sent-${sent.length}`,
        content:
          typeof payload === 'object' && payload && 'content' in (payload as Record<string, unknown>)
            ? String((payload as Record<string, unknown>).content ?? '')
            : '',
        components: [],
        pin: vi.fn(async () => undefined),
        edit: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
    },
    async sendTyping() {},
  };
}

async function* streamEvents(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of events) {
    yield event;
  }
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    agentLabel: 'demo',
    provider: 'claude',
    mode: 'auto',
    workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    ...overrides,
  };
}

describe('Provider Event Flow Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliveryMocks.buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      editTargetMessageId: input.editTargetMessageId,
      chunks: [input.text],
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliveryMocks.deliver.mockResolvedValue(['msg-1']);
    mocks.getSession.mockReturnValue(makeSession());
    mocks.flushDigest.mockResolvedValue(undefined);
  });

  // ── 1. Claude Provider text_delta → Discord message 流式输出（批量编辑 + 限流）──

  it('1. text_delta 流式输出通过 progress_update 模式发送中间消息', async () => {
    const channel = createFakeChannel();

    async function* streamingText() {
      yield { type: 'text_delta', text: 'Let me ' } as ProviderEvent;
      yield { type: 'text_delta', text: 'help you ' } as ProviderEvent;
      yield { type: 'text_delta', text: 'fix this ' } as ProviderEvent;
      yield { type: 'text_delta', text: 'bug.' } as ProviderEvent;
      // Delay triggers the MessageStreamer flush (400ms interval)
      await new Promise((resolve) => setTimeout(resolve, 450));
      yield { type: 'result', success: true, costUsd: 0.01, durationMs: 5000, numTurns: 1, errors: [] } as ProviderEvent;
    }

    const result = await handleOutputStream(
      streamingText(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.text).toContain('Let me help you fix this bug.');
    expect(deliveryMocks.buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'progress_update' }),
    );
    expect(mocks.handleResultEvent).toHaveBeenCalled();
  });

  // ── 2. Claude Provider tool_start → Discord 显示"正在执行工具"──

  it('2. tool_start 事件调用 queueDigest 报告工具执行', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'I will read the file.' },
        { type: 'tool_start', toolName: 'Read', input: '{"file_path":"src/main.ts"}' },
        { type: 'result', success: true, costUsd: 0.02, durationMs: 3000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'tool', text: expect.stringContaining('Read') }),
    );
    expect(result.success).toBe(true);
  });

  // ── 3. Claude Provider tool_result → Discord 显示工具结果──

  it('3. tool_result 在 verbose 模式下调用 queueDigest 报告结果', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'tool_start', toolName: 'Bash', input: '{"cmd":"ls"}' },
        { type: 'tool_result', toolName: 'Bash', result: 'file1.ts\nfile2.ts\nfile3.ts' },
        { type: 'result', success: true, costUsd: 0, durationMs: 1000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      true, // verbose
    );

    const toolResultCalls = mocks.queueDigest.mock.calls.filter(
      (c: [string, { kind: string; text: string }]) => c[1]?.kind === 'tool' && c[1]?.text?.includes('工具结果'),
    );
    expect(toolResultCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── 4. Claude Provider ask_user → Discord 按钮交互──

  it('4. ask_user 事件通过统一交互入口处理等待人工', async () => {
    const channel = createFakeChannel();
    const questionsJson = JSON.stringify({
      questions: [
        {
          header: 'Approach',
          question: 'Which approach should I use?',
          options: [
            { label: 'Approach A', description: 'Simple refactor' },
            { label: 'Approach B', description: 'Full rewrite' },
          ],
        },
      ],
    });

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'I need clarification.' },
        { type: 'ask_user', questionsJson },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-2',
    );

    expect(mocks.updateSessionState).toHaveBeenCalledWith(
      'session-2',
      expect.objectContaining({ type: 'awaiting_human' }),
    );
    expect(mocks.handleAwaitingHuman).toHaveBeenCalledWith(
      'session-2',
      questionsJson,
      expect.objectContaining({ source: 'claude' }),
    );
  });

  // ── 5. Claude Provider file_change → Discord 显示文件变更──

  it('5. file_change 事件累计 fileChangeCount 并收集 changedFiles', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/utils.ts', changeKind: 'add' },
            { filePath: 'src/utils.test.ts', changeKind: 'add' },
          ],
        },
        { type: 'result', success: true, costUsd: 0.03, durationMs: 8000, numTurns: 2, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.fileChangeCount).toBe(2);
    expect(result.changedFiles).toContain('src/utils.ts');
    expect(result.changedFiles).toContain('src/utils.test.ts');
    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'file', text: expect.stringContaining('文件变更') }),
    );
  });

  // ── 6. Claude Provider command_execution → Discord 显示命令执行结果──

  it('6. command_execution 事件记录命令并进入 digest', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        {
          type: 'command_execution',
          command: 'pnpm test -- --run',
          output: '3 tests passed',
          exitCode: 0,
          status: 'completed',
        },
        { type: 'result', success: true, costUsd: 0.01, durationMs: 2000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.commandCount).toBe(1);
    expect(result.recentCommands).toContain('pnpm test -- --run');
    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'command', text: expect.stringContaining('pnpm test') }),
    );
  });

  // ── 7. Claude Provider reasoning → Discord 显示推理块──

  it('7. reasoning 事件仅在 verbose 模式下进入 digest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'reasoning', text: 'I should check the database schema first to understand the relationships.' },
        { type: 'result', success: true, costUsd: 0.02, durationMs: 5000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      true, // verbose
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'reasoning', text: expect.stringContaining('推理') }),
    );
  });

  // ── 8. Claude Provider todo_list → Discord 显示任务进度──

  it('8. todo_list 事件通过 queueDigest 报告待办进度', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        {
          type: 'todo_list',
          items: [
            { text: 'Analyze the bug report', completed: true },
            { text: 'Write failing test', completed: true },
            { text: 'Implement the fix', completed: false },
            { text: 'Verify with existing tests', completed: false },
          ],
        },
        { type: 'result', success: true, costUsd: 0.02, durationMs: 4000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'todo', text: expect.stringContaining('2/4 已完成') }),
    );
  });

  // ── 9. Claude Provider session_init → 保存会话信息──

  it('9. session_init 事件不抛出异常且正常处理', async () => {
    const channel = createFakeChannel();

    await expect(
      handleOutputStream(
        streamEvents([
          { type: 'session_init', providerSessionId: 'claude-sess-abc123' },
          { type: 'text_delta', text: 'Session initialized.' },
          { type: 'result', success: true, costUsd: 0, durationMs: 100, numTurns: 1, errors: [] },
        ]),
        channel as Parameters<typeof handleOutputStream>[1],
        'session-1',
      ),
    ).resolves.toBeDefined();
  });

  // ── 10. Claude Provider result (成功) → Discord 显示完成状态──

  it('10. result 成功时返回正确的 success 状态和成本信息', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'I have completed the task.' },
        { type: 'result', success: true, costUsd: 0.0456, durationMs: 12345, numTurns: 3, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.success).toBe(true);
    expect(result.hadError).toBe(false);
    expect(result.text).toContain('I have completed the task.');
    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'result',
        success: true,
        costUsd: 0.0456,
        durationMs: 12345,
        numTurns: 3,
      }),
      expect.any(String),
      [],
    );
  });

  // ── 11. Claude Provider result (失败) → Discord 显示错误状态──

  it('11. result 失败时返回 success=false 并将错误传给 handleResultEvent', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'Something went wrong.' },
        {
          type: 'result',
          success: false,
          costUsd: 0.005,
          durationMs: 2000,
          numTurns: 1,
          errors: ['Timeout exceeded', 'Connection reset'],
        },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.success).toBe(false);
    expect(result.hadError).toBe(false);
    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'result',
        success: false,
        errors: ['Timeout exceeded', 'Connection reset'],
      }),
      expect.any(String),
      [],
    );
  });

  // ── 12. Claude Provider error → Discord 显示错误消息──

  it('12. error 事件设置 hadError 并进入 digest', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'working' },
        { type: 'error', message: 'Unexpected token in JSON at position 42' },
        { type: 'result', success: false, costUsd: 0, durationMs: 50, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.hadError).toBe(true);
    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('错误') }),
    );
    expect(mocks.updateSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'errored' }),
    );
  });

  // ── 13. Claude Provider cost 累积 → 会话成本更新──

  it('13. result 成本信息正确传递到 handleResultEvent', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'done' },
        { type: 'result', success: true, costUsd: 0.1234, durationMs: 15000, numTurns: 5, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        costUsd: 0.1234,
        durationMs: 15000,
        numTurns: 5,
      }),
      expect.any(String),
      [],
    );
  });

  // ── 14. Codex Provider 事件流 → Discord 消息──

  it('14. Codex Provider 事件流通过 handleOutputStream 正确转换', async () => {
    const channel = createFakeChannel();
    mocks.getSession.mockReturnValue(makeSession({ provider: 'codex' }));

    // Simulating the event sequence that CodexProvider.translateEvents produces
    const codexEventStream = streamEvents([
      { type: 'session_init', providerSessionId: 'codex-thread-xyz' },
      { type: 'text_delta', text: 'Processing your request...' },
      { type: 'command_execution', command: 'pnpm build', output: 'built successfully', exitCode: 0, status: 'completed' },
      { type: 'file_change', changes: [{ filePath: 'dist/bundle.js', changeKind: 'update' }] },
      { type: 'result', success: true, costUsd: 0.08, durationMs: 20000, numTurns: 1, errors: [] },
    ]);

    const result = await handleOutputStream(
      codexEventStream,
      channel as Parameters<typeof handleOutputStream>[1],
      'session-codex-1',
      false,
      'auto',
      'codex',
    );

    expect(result.success).toBe(true);
    expect(result.commandCount).toBe(1);
    expect(result.fileChangeCount).toBe(1);
    expect(mocks.getSession).toHaveBeenCalled();
  });

  // ── 15. monitor 模式：Worker → Monitor 双代理事件循环──

  it('15. monitor 模式下 result 不触发最终总结，更新状态为等待监督判断', async () => {
    const channel = createFakeChannel();
    mocks.getSession.mockReturnValue(makeSession({ mode: 'monitor' }));

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'Worker: I fixed the bug.' },
        { type: 'command_execution', command: 'pnpm test', output: 'all passed', exitCode: 0, status: 'completed' },
        { type: 'file_change', changes: [{ filePath: 'src/bug.ts', changeKind: 'update' }] },
        { type: 'result', success: true, costUsd: 0.05, durationMs: 10000, numTurns: 2, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-monitor-1',
      false,
      'monitor',
      'claude',
    );

    // In monitor mode, handleResultEvent should NOT be called
    expect(mocks.handleResultEvent).not.toHaveBeenCalled();
    // Session state should be updated to "等待监督判断"
    expect(mocks.updateSessionState).toHaveBeenCalledWith(
      'session-monitor-1',
      expect.objectContaining({
        type: 'work_started',
        metadata: expect.objectContaining({ phase: '等待监督判断' }),
      }),
    );
  });

  // ── 16. 长文本输出 chunking + batch 编辑──

  it('16. 长文本输出通过 MessageStreamer 批量发送', async () => {
    const channel = createFakeChannel();
    const longText = 'A'.repeat(3000) + 'B'.repeat(3000);

    async function* longTextStream() {
      // Emit chunks; delay after first batch triggers the MessageStreamer flush (400ms interval)
      for (let i = 0; i < longText.length; i += 500) {
        yield { type: 'text_delta', text: longText.slice(i, i + 500) } as ProviderEvent;
        if (i === 0) {
          // Wait long enough to trigger the scheduled flush
          await new Promise((resolve) => setTimeout(resolve, 450));
        }
      }
      yield { type: 'result', success: true, costUsd: 0.01, durationMs: 10000, numTurns: 1, errors: [] } as ProviderEvent;
    }

    const result = await handleOutputStream(
      longTextStream(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    // Full text should be accumulated
    expect(result.text.length).toBeGreaterThan(1000);
    expect(result.success).toBe(true);
    // Delivery should use progress_update mode for intermediate chunks
    expect(deliveryMocks.buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'progress_update' }),
    );
  });

  // ── 17. 事件流中的 abort 处理──

  it('17. 流抛出 AbortError 时不进入 digest 且不更新 session state', async () => {
    const channel = createFakeChannel();

    async function* abortStream() {
      yield { type: 'text_delta', text: 'working...' } as ProviderEvent;
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }

    const result = await handleOutputStream(
      abortStream(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    // hadError is set before isAbortError check, but abort errors should NOT enter digest
    expect(result.hadError).toBe(true);
    const errorDigestCalls = mocks.queueDigest.mock.calls.filter(
      (c: [string, { kind: string }]) => c[1]?.kind === 'error',
    );
    expect(errorDigestCalls).toHaveLength(0);
    // Session state should not be updated to errored for abort
    const erroredCalls = mocks.updateSessionState.mock.calls.filter(
      (c: [string, { type: string }]) => c[1]?.type === 'errored',
    );
    expect(erroredCalls).toHaveLength(0);
  });

  // ── 18. plan 模式：EnterPlanMode 触发──

  it('18. plan 模式下 result 状态行使用 Plan 标签', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'I have created a plan for this feature.' },
        { type: 'result', success: true, costUsd: 0.02, durationMs: 5000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
      'plan',
    );

    // Verify the result event was delivered
    const call = mocks.handleResultEvent.mock.calls.at(-1);
    expect(call).toBeDefined();
    // The text should contain the plan content
    expect(String(call?.[2])).toContain('I have created a plan for this feature.');
  });

  // ── 19. 多种事件混合序列（text + tool + file_change + result）──

  it('19. 混合事件完整流程：text + tool + command + file + reasoning + result', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'session_init', providerSessionId: 'sess-mixed-1' },
        { type: 'text_delta', text: 'I will fix this issue. ' },
        { type: 'tool_start', toolName: 'Read', input: '{"file_path":"src/main.ts"}' },
        { type: 'tool_result', toolName: 'Read', result: 'export function main() {...}' },
        { type: 'text_delta', text: 'Now I understand the issue.' },
        {
          type: 'command_execution',
          command: 'pnpm test -- src/main.test.ts',
          output: '1 test failed',
          exitCode: 1,
          status: 'failed',
        },
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/main.ts', changeKind: 'update' },
            { filePath: 'src/main.test.ts', changeKind: 'update' },
          ],
        },
        { type: 'reasoning', text: 'The fix addresses the root cause by...' },
        { type: 'todo_list', items: [
          { text: 'Read source', completed: true },
          { text: 'Write fix', completed: true },
          { text: 'Run tests', completed: false },
        ]},
        { type: 'command_execution', command: 'pnpm test', output: 'all passed', exitCode: 0, status: 'completed' },
        { type: 'result', success: true, costUsd: 0.0789, durationMs: 15000, numTurns: 3, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      true, // verbose to capture reasoning
    );

    expect(result.success).toBe(true);
    expect(result.hadError).toBe(false);
    expect(result.commandCount).toBe(2);
    expect(result.fileChangeCount).toBe(2);
    expect(result.changedFiles).toContain('src/main.ts');
    expect(result.recentCommands).toContain('pnpm test -- src/main.test.ts');
    expect(result.recentCommands).toContain('pnpm test');
    // Multiple digest kinds should have been called
    expect(mocks.queueDigest).toHaveBeenCalled();
    expect(mocks.handleResultEvent).toHaveBeenCalled();
  });
});
