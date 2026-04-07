import { describe, expect, it } from 'vitest';

describe('delivery-policy', () => {
  it('按官方规则优先在双换行边界分块', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');
    const text = `alpha\n\n${'b'.repeat(20)}`;

    expect(mod.chunkText(text, 12, 'newline')).toEqual(['alpha\n\nbbbbb', 'bbbbbbbbbbbb', 'bbb']);
  });

  it('在 length 模式下直接硬切', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');

    expect(mod.chunkText('abcdefghij', 4, 'length')).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('只让第一块携带附件与引用', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');

    expect(
      mod.buildDeliveryPlan({
        sessionId: 'session-1',
        chatId: 'chat-1',
        text: 'A'.repeat(9),
        files: ['/tmp/a.png', '/tmp/b.png'],
        mode: 'user_reply',
        replyToMessageId: 'msg-1',
        policy: {
          textChunkLimit: 4,
          chunkMode: 'length',
          replyToMode: 'first',
          ackReaction: '👀',
        },
      }),
    ).toEqual({
      sessionId: 'session-1',
      chatId: 'chat-1',
      replyToMessageId: 'msg-1',
      replyToMode: 'first',
      editTargetMessageId: undefined,
      chunks: ['AAAA', 'AAAA', 'A'],
      filesOnFirstChunk: ['/tmp/a.png', '/tmp/b.png'],
      mode: 'user_reply',
    });
  });

  it('保留 replyToMode=all 同时仍能引用', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');

    const plan = mod.buildDeliveryPlan({
      sessionId: 'session-1',
      chatId: 'chat-1',
      text: 'A'.repeat(3),
      files: [],
      mode: 'user_reply',
      replyToMessageId: 'msg-2',
      policy: {
        textChunkLimit: 2000,
        chunkMode: 'length',
        replyToMode: 'all',
        ackReaction: '👀',
      },
    });

    expect(plan.replyToMode).toBe('all');
    expect(plan.replyToMessageId).toBe('msg-2');
  });

  it('系统通知强制不引用', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');

    expect(
      mod.buildDeliveryPlan({
        sessionId: 'session-1',
        chatId: 'chat-1',
        text: 'done',
        files: [],
        mode: 'system_notice',
        replyToMessageId: 'msg-1',
        policy: {
          textChunkLimit: 2000,
          chunkMode: 'length',
          replyToMode: 'all',
          ackReaction: '👀',
        },
      }).replyToMessageId,
    ).toBeUndefined();
  });

  it('超过附件数量限制会报错', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');
    expect(() =>
      mod.buildDeliveryPlan({
        sessionId: 'session-1',
        chatId: 'chat-1',
        text: 'A',
        files: new Array(11).fill('/tmp/file.png'),
        mode: 'user_reply',
        policy: {
          textChunkLimit: 2000,
          chunkMode: 'length',
          replyToMode: 'first',
          ackReaction: '👀',
        },
      }),
    ).toThrow('最多只能发送 10 个附件');
  });

  it('空附件路径会报错', async () => {
    const mod = await import('../src/discord/delivery-policy.ts');
    expect(() =>
      mod.buildDeliveryPlan({
        sessionId: 'session-1',
        chatId: 'chat-1',
        text: 'A',
        files: [''],
        mode: 'user_reply',
        policy: {
          textChunkLimit: 2000,
          chunkMode: 'length',
          replyToMode: 'first',
          ackReaction: '👀',
        },
      }),
    ).toThrow('附件路径无效');
  });
});
