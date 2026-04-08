import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('delivery', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('typing 失败时吞掉异常', async () => {
    const mod = await import('../src/discord/delivery.ts');
    const channel = {
      sendTyping: vi.fn(async () => {
        throw new Error('forbidden');
      }),
    };

    await expect(mod.sendTyping(channel as never)).resolves.toBeUndefined();
  });

  it('空 ackReaction 直接跳过 react', async () => {
    const mod = await import('../src/discord/delivery.ts');
    const message = { react: vi.fn() };

    await mod.sendAckReaction(message as never, '');

    expect(message.react).not.toHaveBeenCalled();
  });

  it('普通消息只让第一块带附件与引用', async () => {
    const mod = await import('../src/discord/delivery.ts');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ id: 'm1' })
      .mockResolvedValueOnce({ id: 'm2' })
      .mockResolvedValueOnce({ id: 'm3' });
    const channel = { send };

    const ids = await mod.deliver(channel as never, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      replyToMessageId: 'user-1',
      replyToMode: 'first',
      chunks: ['one', 'two', 'three'],
      filesOnFirstChunk: ['/tmp/a.png'],
      mode: 'user_reply',
    });

    expect(ids).toEqual(['m1', 'm2', 'm3']);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: 'one',
        files: ['/tmp/a.png'],
        reply: expect.objectContaining({ messageReference: 'user-1' }),
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, { content: 'two' });
    expect(send).toHaveBeenNthCalledWith(3, { content: 'three' });
  });

  it('progress_update 优先编辑旧消息，失败后退化为新发', async () => {
    const mod = await import('../src/discord/delivery.ts');
    const edit = vi.fn(async () => {
      throw new Error('gone');
    });
    const send = vi.fn().mockResolvedValue({ id: 'fresh-1' });
    const channel = {
      send,
      messages: {
        edit,
      },
    };

    const ids = await mod.deliver(channel as never, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      editTargetMessageId: 'bot-1',
      chunks: ['working...'],
      filesOnFirstChunk: [],
      replyToMode: 'first',
      mode: 'progress_update',
    });

    expect(edit).toHaveBeenCalledWith('bot-1', { content: 'working...' });
    expect(send).toHaveBeenCalledWith({ content: 'working...' });
    expect(ids).toEqual(['fresh-1']);
  });

  it('引用失败会降级为普通消息', async () => {
    const mod = await import('../src/discord/delivery.ts');
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing reference'))
      .mockResolvedValueOnce({ id: 'fallback' });
    const channel = { send };

    const ids = await mod.deliver(channel as never, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      replyToMessageId: 'user-1',
      replyToMode: 'first',
      chunks: ['one'],
      filesOnFirstChunk: [],
      mode: 'user_reply',
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        content: 'one',
        reply: expect.objectContaining({ messageReference: 'user-1' }),
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, { content: 'one' });
    expect(ids).toEqual(['fallback']);
  });

  it("replyToMode='all' 会让每块都带引用", async () => {
    const mod = await import('../src/discord/delivery.ts');
    const send = vi
      .fn()
      .mockResolvedValueOnce({ id: 'm1' })
      .mockResolvedValueOnce({ id: 'm2' });
    const channel = { send };

    await mod.deliver(channel as never, {
      sessionId: 'session-1',
      chatId: 'chat-1',
      replyToMessageId: 'user-1',
      replyToMode: 'all',
      chunks: ['one', 'two'],
      filesOnFirstChunk: [],
      mode: 'user_reply',
    });

    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        reply: expect.objectContaining({ messageReference: 'user-1' }),
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        reply: expect.objectContaining({ messageReference: 'user-1' }),
      }),
    );
  });
});
