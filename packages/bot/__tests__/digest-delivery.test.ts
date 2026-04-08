import { describe, expect, it, vi } from 'vitest';

function createDigestChannel(overrides: Partial<Record<'send' | 'edit' | 'delete', any>> = {}) {
  const sendFn = overrides.send ?? vi.fn(async () => ({ id: `msg-${Date.now()}-${Math.random()}` }));
  const editFn = overrides.edit ?? vi.fn(async () => ({ id: 'edited' }));
  const deleteFn = overrides.delete ?? vi.fn(async () => undefined);

  const channel = {
    send: sendFn,
    messages: {
      edit: editFn,
      delete: deleteFn,
    },
  };
  return { channel, sendFn, editFn, deleteFn };
}

describe('DigestDelivery', () => {
  it('send 空内容不发送任何消息', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    await digest.send('');

    expect(sendFn).not.toHaveBeenCalled();
  });

  it('send 仅空白内容不发送任何消息', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    await digest.send('   \n  ');

    expect(sendFn).not.toHaveBeenCalled();
  });

  it('send 短文本发送单条 embed 消息', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    await digest.send('Short summary');

    expect(sendFn).toHaveBeenCalledTimes(1);
    const payload = sendFn.mock.calls[0][0];
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].data.description).toBe('Short summary');
    expect(payload.embeds[0].data.title).toBe('\ud83d\udccc 最近摘要');
  });

  it('send 长文本自动分块', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    const longText = 'B'.repeat(4000);
    await digest.send(longText);

    expect(sendFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('send 分块消息带有页脚标注', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    const longText = 'C'.repeat(4000);
    await digest.send(longText);

    const firstEmbed = sendFn.mock.calls[0][0].embeds[0];
    expect(firstEmbed.data.footer?.text).toContain('1/');
  });

  it('send 单块消息带有相对时间页脚', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    await digest.send('Single chunk');

    const embed = sendFn.mock.calls[0][0].embeds[0];
    expect(embed.data.title).toBe('\ud83d\udccc 最近摘要');
    expect(embed.data.footer?.text).toContain('<t:');
    expect(embed.data.footer?.text).toContain(':R>');
  });

  it('多次 send 调用会复用已存在的消息进行编辑', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const sendFn = vi.fn(async () => ({ id: 'digest-msg-1' }));
    const editFn = vi.fn(async (id) => ({ id }));
    const channel = {
      send: sendFn,
      messages: { edit: editFn },
    };

    const digest = new DigestDelivery(channel as never);

    // First send creates a new message
    await digest.send('Update 1');
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(editFn).not.toHaveBeenCalled();

    // Second send should edit the existing message
    await digest.send('Update 2');
    expect(editFn).toHaveBeenCalledWith('digest-msg-1', expect.objectContaining({
      embeds: expect.any(Array),
    }));
    // No new message should be sent
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('编辑失败后回退到新发送并删除旧消息', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const sendFn = vi.fn(async () => ({ id: 'new-digest-msg' }));
    const editFn = vi.fn(async () => {
      throw new Error('Message not found');
    });
    const deleteFn = vi.fn(async () => undefined);
    const channel = {
      send: sendFn,
      messages: { edit: editFn, delete: deleteFn },
    };

    const digest = new DigestDelivery(channel as never);

    // First send
    await digest.send('Initial');
    expect(sendFn).toHaveBeenCalledTimes(1);

    // Next send: edit fails, should fall back to send + delete old
    await digest.send('Updated content');

    expect(editFn).toHaveBeenCalled();
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(deleteFn).toHaveBeenCalled();
  });

  it('relocateToBottom 在空状态下返回空数组', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn } = createDigestChannel();

    const digest = new DigestDelivery(channel as never);
    const result = await digest.relocateToBottom();

    expect(result).toEqual({ oldMessageIds: [], newMessageIds: [] });
    expect(sendFn).not.toHaveBeenCalled();
  });

  it('relocateToBottom 重建所有消息并返回旧新 ID 映射', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const { channel, sendFn, editFn } = createDigestChannel();

    // First, send some content to create messages
    const digest = new DigestDelivery(channel as never);
    await digest.send('Content part 1\n\nContent part 2');

    const sendCountAfterFirst = sendFn.mock.calls.length;

    // Now relocate
    sendFn.mockClear();
    editFn.mockClear();

    const result = await digest.relocateToBottom();

    expect(result.oldMessageIds.length).toBe(sendCountAfterFirst);
    expect(result.newMessageIds.length).toBe(sendCountAfterFirst);
    expect(sendFn).toHaveBeenCalledTimes(result.newMessageIds.length);
  });

  it('relocateToBottom 失败时清理已创建的新消息', async () => {
    const { DigestDelivery } = await import('../src/discord/digest-delivery.ts');
    const deleteFn = vi.fn(async () => undefined);
    const sendFn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'initial-msg-1' })
      .mockResolvedValueOnce({ id: 'initial-msg-2' })
      .mockResolvedValueOnce({ id: 'relocated-1' })
      .mockRejectedValueOnce(new Error('rate limited'));
    const channel = {
      send: sendFn,
      messages: { delete: deleteFn },
    };

    const digest = new DigestDelivery(channel as never);
    // Seed state with content that creates exactly 2 chunks (1900 + 1 chars)
    await digest.send('X'.repeat(1901));

    sendFn.mockClear();

    await expect(digest.relocateToBottom()).rejects.toThrow('rate limited');

    // Should have deleted the one message that was created before failure
    expect(deleteFn).toHaveBeenCalledWith('relocated-1');
  });
});
