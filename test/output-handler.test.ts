import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent } from '../src/providers/types.ts';

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
vi.mock('../src/thread-manager.ts', () => ({
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
    const filePath = '/Users/ld/Documents/github/agentcord/tmp/test-image.png';
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

});
