import { describe, expect, it, vi } from 'vitest';

describe('delivery-notices', () => {
  it('sendSystemNotice 在空文本时直接返回，不调用 deliver', async () => {
    const mod = await import('../src/discord/delivery-notices.ts');

    const fakeChannel = { send: vi.fn() } as never;
    await mod.sendSystemNotice(fakeChannel, 'session-1', '');

    expect(fakeChannel.send).not.toHaveBeenCalled();
  });

  it('sendSystemNotice 在仅空白字符时直接返回', async () => {
    const mod = await import('../src/discord/delivery-notices.ts');

    const fakeChannel = { send: vi.fn() } as never;
    await mod.sendSystemNotice(fakeChannel, 'session-1', '   \n  ');

    expect(fakeChannel.send).not.toHaveBeenCalled();
  });

  it('sendSystemNotice 正常调用 deliver 并构建 system_notice 计划', async () => {
    const mod = await import('../src/discord/delivery-notices.ts');
    const delivery = await import('../src/discord/delivery.ts');

    const deliverSpy = vi.spyOn(delivery, 'deliver').mockResolvedValue(['msg-1']);

    const fakeChannel = { send: vi.fn(async () => ({ id: 'msg-1' })) } as never;
    await mod.sendSystemNotice(fakeChannel, 'session-abc', 'Task completed', 'reply-target');

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const plan = deliverSpy.mock.calls[0]?.[1];
    expect(plan.sessionId).toBe('session-abc');
    expect(plan.mode).toBe('system_notice');
    expect(plan.replyToMessageId).toBeUndefined();
    expect(plan.chunks).toEqual(['Task completed']);
    expect(plan.filesOnFirstChunk).toEqual([]);

    deliverSpy.mockRestore();
  });

  it('sendSystemNotice 强制关闭引用（即使传入 replyToMessageId）', async () => {
    const mod = await import('../src/discord/delivery-notices.ts');
    const delivery = await import('../src/discord/delivery.ts');

    const deliverSpy = vi.spyOn(delivery, 'deliver').mockResolvedValue(['msg-1']);

    const fakeChannel = { send: vi.fn(async () => ({ id: 'msg-1' })) } as never;
    await mod.sendSystemNotice(fakeChannel, 'session-1', 'notice', 'some-msg-id');

    const plan = deliverSpy.mock.calls[0]?.[1];
    expect(plan.replyToMessageId).toBeUndefined();

    deliverSpy.mockRestore();
  });

  it('sendSystemNotice 吞掉 deliver 抛出的错误', async () => {
    const mod = await import('../src/discord/delivery-notices.ts');
    const delivery = await import('../src/discord/delivery.ts');

    const deliverSpy = vi
      .spyOn(delivery, 'deliver')
      .mockRejectedValue(new Error('network error'));

    const fakeChannel = { send: vi.fn() } as never;
    await expect(
      mod.sendSystemNotice(fakeChannel, 'session-1', 'will fail'),
    ).resolves.toBeUndefined();

    deliverSpy.mockRestore();
  });

  it('sendSystemNotice 长文本会分块', async () => {
    const mod = await import('../src/discord/delivery-notices.ts');
    const delivery = await import('../src/discord/delivery.ts');

    const deliverSpy = vi.spyOn(delivery, 'deliver').mockResolvedValue(['msg-1', 'msg-2']);

    const fakeChannel = { send: vi.fn(async () => ({ id: 'msg-1' })) } as never;
    const longText = 'A'.repeat(3000);
    await mod.sendSystemNotice(fakeChannel, 'session-1', longText);

    const plan = deliverSpy.mock.calls[0]?.[1];
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.chunks.join('')).toBe(longText);

    deliverSpy.mockRestore();
  });
});
