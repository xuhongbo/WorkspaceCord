import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildDeliveryPlan = vi.fn();
const chunkText = vi.fn();
const deliver = vi.fn();

vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan,
  chunkText,
}));

vi.mock('../src/discord/delivery.ts', () => ({
  deliver,
}));

const { SummaryHandler } = await import('../src/discord/summary-handler.ts');

function createChannel() {
  return {
    send: vi.fn(async () => ({ id: 'm1' })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  };
}

describe('SummaryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chunkText.mockImplementation((content, limit) => {
      const pieces = [];
      for (let i = 0; i < content.length; i += limit) pieces.push(content.slice(i, i + limit));
      return pieces;
    });
    buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      editTargetMessageId: input.editTargetMessageId,
      chunks: [input.text],
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliver.mockResolvedValue(['m1']);
  });

  it('本轮完成通过统一投递层发送最终可见消息', async () => {
    const channel = createChannel();
    const statusCard = { update: vi.fn(async () => undefined) };
    const handler = new SummaryHandler('session-1', 'chat-1', channel as never, statusCard as never);

    await handler.sendTurnSummary('任务完成', 3, 'user-msg-1');

    expect(buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        chatId: 'chat-1',
        mode: 'user_reply',
        replyToMessageId: 'user-msg-1',
        text: expect.stringContaining('任务完成'),
        files: [],
      }),
    );
    expect(deliver).toHaveBeenCalledWith(channel, expect.objectContaining({ mode: 'user_reply', replyToMessageId: 'user-msg-1' }));
    expect(statusCard.update).toHaveBeenCalledWith('idle', expect.objectContaining({ turn: 4 }));
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('发送最终摘要时可以携带附件', async () => {
    const channel = createChannel();
    const statusCard = { update: vi.fn(async () => undefined) };
    const handler = new SummaryHandler('session-1', 'chat-1', channel as never, statusCard as never);
    const attachments = ['/tmp/attachment.png'];

    await handler.sendTurnSummary('任务完成', 1, 'user-msg-1', attachments);

    expect(buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        files: attachments,
      }),
    );
    expect(deliver).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ filesOnFirstChunk: attachments }),
    );
  });

  it('摘要首次创建通过统一投递层发送，后续刷新优先复用已有消息', async () => {
    const channel = createChannel();
    const statusCard = { update: vi.fn(async () => undefined) };
    buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      editTargetMessageId: input.editTargetMessageId,
      chunks: chunkText(input.text, 1900),
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliver.mockResolvedValueOnce(['m1', 'm2']).mockResolvedValueOnce(['m3']);
    const handler = new SummaryHandler('session-1', 'chat-1', channel as never, statusCard as never);

    await handler.sendDigestSummary('A'.repeat(2500));
    expect(deliver).toHaveBeenCalledWith(channel, expect.objectContaining({ mode: 'log' }));
    expect(channel.send).not.toHaveBeenCalled();

    await handler.sendDigestSummary('B'.repeat(2500));
    expect(channel.messages.edit).toHaveBeenCalledTimes(2);
  });

  it('前块编辑失败时仍保持摘要顺序并清理陈旧消息', async () => {
    const channel = createChannel();
    const statusCard = { update: vi.fn(async () => undefined) };
    buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      replyToMessageId: input.replyToMessageId,
      editTargetMessageId: input.editTargetMessageId,
      chunks: chunkText(input.text, 1900),
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliver.mockResolvedValueOnce(['m1', 'm2']).mockResolvedValueOnce(['m3']);
    const handler = new SummaryHandler('session-1', 'chat-1', channel as never, statusCard as never);

    await handler.sendDigestSummary('A'.repeat(2500));
    channel.messages.edit.mockImplementationOnce(async () => { throw new Error('gone'); }).mockImplementationOnce(async () => undefined);

    await handler.sendDigestSummary('B'.repeat(2500));

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(channel.messages.delete).toHaveBeenCalledTimes(1);
  });

});
