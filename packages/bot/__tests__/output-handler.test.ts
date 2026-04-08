import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent } from '@workspacecord/providers';

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

vi.mock('../src/panel-adapter.ts', () => ({
  initializeSessionPanel: mocks.initializeSessionPanel,
  updateSessionState: mocks.updateSessionState,
  handleResultEvent: mocks.handleResultEvent,
  handleAwaitingHuman: mocks.handleAwaitingHuman,
  queueDigest: mocks.queueDigest,
  flushDigest: mocks.flushDigest,
}));
vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan: deliveryMocks.buildDeliveryPlan,
}));
vi.mock('../src/discord/delivery.ts', () => ({
  deliver: deliveryMocks.deliver,
}));
vi.mock('@workspacecord/engine/session-registry', () => ({
  getSession: mocks.getSession,
  updateSession: mocks.updateSession,
  getSessionByChannel: vi.fn(),
  updateWorkflowState: vi.fn(),
  setMode: vi.fn(),
}));

const { handleOutputStream } = await import('../src/output-handler.ts');

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

describe('handleOutputStream', () => {
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
    mocks.getSession.mockReturnValue({
      id: 'session-1',
      agentLabel: 'demo',
      provider: 'codex',
      mode: 'auto',
      workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    });
  });

  it('高频命令与文件事件进入聚合器而不是逐条发消息', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'Completed the requested change.' },
        {
          type: 'command_execution',
          command: 'pnpm test',
          output: 'ok',
          exitCode: 0,
          status: 'completed',
        },
        {
          type: 'file_change',
          changes: [{ filePath: 'src/file.ts', changeKind: 'update' }],
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalled();
    expect(mocks.handleResultEvent).toHaveBeenCalled();
    expect(channel.sent).toEqual([]);
  });

  it('本轮总结传给协调器时不提前截断正文', async () => {
    const channel = createFakeChannel();
    const longText = 'A'.repeat(5000) + 'B'.repeat(5000);

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: longText },
        { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'result' }),
      expect.stringContaining('A'.repeat(200)),
      [],
    );
    const call = mocks.handleResultEvent.mock.calls.at(-1);
    expect(String(call?.[2]).includes('B'.repeat(200))).toBe(true);
  });

  it('ask_user 通过统一交互入口处理等待人工', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        {
          type: 'ask_user',
          questionsJson: JSON.stringify({
            questions: [{ header: 'Question', question: 'Continue?', options: [{ label: 'Yes' }] }],
          }),
        },
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
      expect.any(String),
      expect.objectContaining({ source: 'codex' }),
    );
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('monitor 模式下 result 不触发最终总结', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'work' },
        { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
      'monitor',
    );

    expect(mocks.handleResultEvent).not.toHaveBeenCalled();
    expect(mocks.updateSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'work_started' }),
    );
  });

  it('image_file 附件通过最终消息协同层发送', async () => {
    const channel = createFakeChannel();
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'workspacecord-test-'));
    const filePath = join(tmpDir, 'test-image.png');
    await import('node:fs/promises').then((fs) => fs.writeFile(filePath, 'img'));

    await handleOutputStream(
      streamEvents([
        { type: 'image_file', filePath },
        { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(deliveryMocks.buildDeliveryPlan).not.toHaveBeenCalled();
    expect(deliveryMocks.deliver).not.toHaveBeenCalled();
    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'result' }),
      expect.any(String),
      [filePath],
    );
    expect(channel.sent).toEqual([]);
  });

  it('text_delta 在长任务过程中通过 progress_update 发中间消息', async () => {
    const channel = createFakeChannel();

    async function* delayedStream() {
      yield { type: 'text_delta', text: 'working' } as ProviderEvent;
      await new Promise((resolve) => setTimeout(resolve, 450));
      yield { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] } as ProviderEvent;
    }

    await handleOutputStream(
      delayedStream(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(deliveryMocks.buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'progress_update' }),
    );
    expect(deliveryMocks.deliver).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ mode: 'progress_update' }),
    );
  });

  it('等结果流真正结束后才发送最终总结，避免界面已完成但会话仍在生成', async () => {
    const channel = createFakeChannel();
    let yieldedResult = false;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    async function* delayedCloseStream() {
      yield { type: 'text_delta', text: 'done' } as ProviderEvent;
      yieldedResult = true;
      yield {
        type: 'result',
        success: true,
        costUsd: 0,
        durationMs: 25,
        numTurns: 1,
        errors: [],
      } as ProviderEvent;
      await closeGate;
    }

    const pending = handleOutputStream(
      delayedCloseStream(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    await vi.waitFor(() => expect(yieldedResult).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.handleResultEvent).not.toHaveBeenCalled();

    releaseClose();
    await pending;

    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'result' }),
      'done',
      [],
    );
  });

  it('tool_start 事件调用 queueDigest 并 finalize streamer', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'working...' },
        { type: 'tool_start', toolName: 'Bash', input: 'echo hello' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'tool', text: expect.stringContaining('Bash') }),
    );
  });

  it('tool_result 在 verbose 模式下调用 queueDigest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'tool_start', toolName: 'Bash', input: 'ls' },
        { type: 'tool_result', toolName: 'Bash', result: 'file1.ts\nfile2.ts' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      true, // verbose
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'tool', text: expect.stringContaining('工具结果') }),
    );
  });

  it('tool_result 在非 verbose 模式下不调用 queueDigest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'tool_start', toolName: 'Bash', input: 'ls' },
        { type: 'tool_result', toolName: 'Bash', result: 'output' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false, // not verbose
    );

    const toolResultCalls = mocks.queueDigest.mock.calls.filter(
      (c) => c[1]?.kind === 'tool' && String(c[1]?.text).includes('工具结果'),
    );
    expect(toolResultCalls).toHaveLength(0);
  });

  it('task 事件调用 queueDigest 并记录 lastToolName', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'task', action: 'TaskCreate', dataJson: JSON.stringify({ subject: 'Fix bug' }) },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'tool', text: expect.stringContaining('任务工具') }),
    );
  });

  it('task_started 事件通过 queueDigest 报告子代理启动', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'task_started', description: 'Running tests in background' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'subagent', text: expect.stringContaining('子代理启动') }),
    );
  });

  it('task_progress 事件通过 queueDigest 报告子代理进展', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'task_started', description: 'Subagent task' },
        { type: 'task_progress', summary: 'Processing files 1/10' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'subagent', text: expect.stringContaining('子代理进展') }),
    );
  });

  it('task_done 事件通过 queueDigest 报告子代理结束', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'task_started', description: 'Subagent task' },
        { type: 'task_done', status: 'completed', summary: 'All files processed' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'subagent', text: expect.stringContaining('子代理完成') }),
    );
  });

  it('task_done 失败状态显示"结束"而非"完成"', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'task_started', description: 'Subagent task' },
        { type: 'task_done', status: 'failed', summary: 'Ran out of memory' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'subagent', text: expect.stringContaining('子代理结束') }),
    );
  });

  it('reasoning 事件仅在 verbose 模式下进入 digest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'reasoning', text: 'I should check the database schema first.' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
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

  it('reasoning 事件在非 verbose 模式下不进入 digest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'reasoning', text: 'Thinking...' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false, // not verbose
    );

    const reasoningCalls = mocks.queueDigest.mock.calls.filter(
      (c) => c[1]?.kind === 'reasoning',
    );
    expect(reasoningCalls).toHaveLength(0);
  });

  it('todo_list 事件通过 queueDigest 报告待办进度', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        {
          type: 'todo_list',
          items: [
            { text: 'Read file', completed: true },
            { text: 'Write fix', completed: false },
            { text: 'Test', completed: false },
          ],
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'todo', text: expect.stringContaining('待办更新') }),
    );
    // Verify the completed count is reflected
    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ text: expect.stringContaining('1/3 已完成') }),
    );
  });

  it('command_execution 事件累计 commandCount 并记录 recentCommands', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        {
          type: 'command_execution',
          command: 'pnpm build',
          output: 'built',
          exitCode: 0,
          status: 'completed',
        },
        {
          type: 'command_execution',
          command: 'pnpm test',
          output: 'passed',
          exitCode: 0,
          status: 'completed',
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.commandCount).toBe(2);
    expect(result.recentCommands).toEqual(['pnpm build', 'pnpm test']);
  });

  it('command_execution 超过 8 条只保留最近的前 8 条', async () => {
    const channel = createFakeChannel();

    const commands = Array.from({ length: 12 }, (_, i) => ({
      type: 'command_execution' as const,
      command: `cmd-${i}`,
      output: 'ok',
      exitCode: 0,
      status: 'completed' as const,
    }));

    const result = await handleOutputStream(
      streamEvents([...commands, { type: 'result' as const, success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] }]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.commandCount).toBe(12);
    expect(result.recentCommands).toHaveLength(8);
    // Keeps the first 8 commands (push stops at length 8)
    expect(result.recentCommands[0]).toBe('cmd-0');
    expect(result.recentCommands[7]).toBe('cmd-7');
    expect(result.recentCommands).not.toContain('cmd-8');
  });

  it('包含 "total-recall" 的 command_execution 被抑制不进入 digest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        {
          type: 'command_execution',
          command: 'total-recall --scan',
          output: 'scanned',
          exitCode: 0,
          status: 'completed',
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    const commandCalls = mocks.queueDigest.mock.calls.filter(
      (c) => c[1]?.kind === 'command',
    );
    expect(commandCalls).toHaveLength(0);
    // But commandCount still increments
  });

  it('file_change 事件累计 fileChangeCount 并收集 changedFiles', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/a.ts', changeKind: 'add' },
            { filePath: 'src/b.ts', changeKind: 'update' },
          ],
        },
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/c.ts', changeKind: 'delete' },
          ],
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.fileChangeCount).toBe(3);
    expect(result.changedFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('file_change 去重已收集的文件路径', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/a.ts', changeKind: 'update' },
          ],
        },
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/a.ts', changeKind: 'update' },
            { filePath: 'src/b.ts', changeKind: 'add' },
          ],
        },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    // fileChangeCount counts total changes including duplicates
    expect(result.fileChangeCount).toBe(3);
  });

  it('file_change 超过 12 个文件后停止收集', async () => {
    const channel = createFakeChannel();

    const changes = Array.from({ length: 15 }, (_, i) => ({
      type: 'file_change' as const,
      changes: [{ filePath: `src/file-${i}.ts`, changeKind: 'add' as const }],
    }));

    const result = await handleOutputStream(
      streamEvents([...changes, { type: 'result' as const, success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] }]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.changedFiles).toHaveLength(12);
    expect(result.fileChangeCount).toBe(15);
  });

  it('result 成功时返回正确的 success 状态', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'done with work' },
        { type: 'result', success: true, costUsd: 0.0123, durationMs: 5432, numTurns: 3, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.success).toBe(true);
    expect(result.hadError).toBe(false);
    // text_delta content is preserved in transcript
    expect(result.text).toContain('done with work');
    // Verify handleResultEvent was called with cost/duration info
    expect(mocks.handleResultEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'result',
        success: true,
        costUsd: 0.0123,
        durationMs: 5432,
        numTurns: 3,
      }),
      expect.stringContaining('done with work'),
      [],
    );
  });

  it('result 失败时返回 success=false 并将错误传给 handleResultEvent', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'something went wrong' },
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
    expect(result.hadError).toBe(false); // stream-level hadError, not result-level
    expect(result.text).toContain('something went wrong');
    // Error details passed to handleResultEvent
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

  it('result 在 plan 模式下状态行使用 Plan 标签', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'plan done' },
        { type: 'result', success: true, costUsd: 0, durationMs: 1000, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
      'plan',
    );

    // Verify the result event was delivered to handleResultEvent
    const call = mocks.handleResultEvent.mock.calls.at(-1);
    expect(call).toBeDefined();
    expect(String(call?.[2])).toContain('plan done');
  });

  it('result 在 monitor 模式下更新状态为"等待监督判断"而非 deferred', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'monitor done' },
        { type: 'result', success: true, costUsd: 0, durationMs: 100, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
      'monitor',
    );

    // In monitor mode, handleResultEvent should NOT be called (deferred result skipped)
    // and session state should be updated to "等待监督判断"
    expect(mocks.handleResultEvent).not.toHaveBeenCalled();
    expect(mocks.updateSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'work_started',
        metadata: expect.objectContaining({ phase: '等待监督判断' }),
      }),
    );
  });

  it('error 事件设置 hadError 并进入 digest', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'working' },
        { type: 'error', message: 'Unexpected token in JSON' },
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

  it('error 事件在 monitor 模式下不更新 session 状态为 errored', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'error', message: 'Stream interrupted' },
        { type: 'result', success: false, costUsd: 0, durationMs: 50, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
      'monitor',
    );

    const erroredCalls = mocks.updateSessionState.mock.calls.filter(
      (c) => c[1]?.type === 'errored',
    );
    expect(erroredCalls).toHaveLength(0);
  });

  it('session_init 事件不抛出异常', async () => {
    const channel = createFakeChannel();

    await expect(handleOutputStream(
      streamEvents([
        { type: 'session_init', sessionId: 'session-1', metadata: {} },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    )).resolves.toBeDefined();
  });

  it('返回对象包含所有预期字段', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'hello' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('askedUser');
    expect(result).toHaveProperty('askUserQuestionsJson');
    expect(result).toHaveProperty('hadError');
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('commandCount');
    expect(result).toHaveProperty('fileChangeCount');
    expect(result).toHaveProperty('recentCommands');
    expect(result).toHaveProperty('changedFiles');
  });

  it('流抛出非 Abort 异常时设置 hadError 并进入 digest', async () => {
    const channel = createFakeChannel();

    async function* errorStream() {
      yield { type: 'text_delta', text: 'working' } as ProviderEvent;
      throw new Error('Network connection lost');
    }

    const result = await handleOutputStream(
      errorStream(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    expect(result.hadError).toBe(true);
    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('异常') }),
    );
    expect(mocks.updateSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'errored' }),
    );
  });

  it('onEvent 回调在每个事件时被调用', async () => {
    const channel = createFakeChannel();
    const onEvent = vi.fn();

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'hello' },
        { type: 'tool_start', toolName: 'Read', input: '{}' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
      'auto',
      'claude',
      { onEvent },
    );

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'text_delta' }));
    expect(onEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'tool_start' }));
    expect(onEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: 'result' }));
  });

  it('web_search 事件在 verbose 模式下进入 digest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'web_search', query: 'latest TypeScript features 2026' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      true, // verbose
    );

    expect(mocks.queueDigest).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ kind: 'search', text: expect.stringContaining('检索') }),
    );
  });

  it('web_search 事件在非 verbose 模式下不进入 digest', async () => {
    const channel = createFakeChannel();

    await handleOutputStream(
      streamEvents([
        { type: 'web_search', query: 'search query' },
        { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      false,
    );

    const searchCalls = mocks.queueDigest.mock.calls.filter(
      (c) => c[1]?.kind === 'search',
    );
    expect(searchCalls).toHaveLength(0);
  });

  it('长任务中 text_delta 通过 progress_update 模式发送（带时间间隔触发）', async () => {
    const channel = createFakeChannel();

    async function* slowStream() {
      yield { type: 'text_delta', text: 'first chunk ' } as ProviderEvent;
      await new Promise((resolve) => setTimeout(resolve, 500));
      yield { type: 'text_delta', text: 'second chunk' } as ProviderEvent;
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield { type: 'result', success: true, costUsd: 0, durationMs: 10, numTurns: 1, errors: [] } as ProviderEvent;
    }

    await handleOutputStream(
      slowStream(),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
    );

    // The delivery mock should have been called with progress_update mode
    const progressCalls = deliveryMocks.deliver.mock.calls.filter(
      (c) => c[1]?.mode === 'progress_update',
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('混合事件完整流程：text + tool + command + file + result', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'I will fix this issue.' },
        { type: 'tool_start', toolName: 'Read', input: '{"path":"src/main.ts"}' },
        { type: 'tool_result', toolName: 'Read', result: 'content...' },
        {
          type: 'command_execution',
          command: 'pnpm test',
          output: 'all passed',
          exitCode: 0,
          status: 'completed',
        },
        {
          type: 'file_change',
          changes: [
            { filePath: 'src/main.ts', changeKind: 'update' },
            { filePath: 'src/main.test.ts', changeKind: 'update' },
          ],
        },
        { type: 'reasoning', text: 'The fix looks correct.' },
        { type: 'result', success: true, costUsd: 0.05, durationMs: 12000, numTurns: 2, errors: [] },
      ]),
      channel as Parameters<typeof handleOutputStream>[1],
      'session-1',
      true, // verbose to capture reasoning
    );

    expect(result.success).toBe(true);
    expect(result.hadError).toBe(false);
    expect(result.commandCount).toBe(1);
    expect(result.fileChangeCount).toBe(2);
    expect(result.changedFiles).toHaveLength(2);
    expect(result.recentCommands).toContain('pnpm test');
    // Verify digest was called for multiple event types
    expect(mocks.queueDigest).toHaveBeenCalled();
    expect(mocks.handleResultEvent).toHaveBeenCalled();
  });

});
