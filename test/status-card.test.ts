import { describe, expect, it, vi } from 'vitest';

import { StatusCard } from '../src/discord/status-card.ts';

function createChannel(overrides: Partial<Record<'send' | 'edit', any>> = {}) {
  const pinStub = vi.fn(async () => undefined);
  const sendPinStub = vi.fn(async () => undefined);
  const channel = {
    send: overrides.send ?? (vi.fn(async () => ({ id: 'sent', pin: sendPinStub }))),
    messages: {
      edit: overrides.edit ?? (vi.fn(async () => ({ id: 'edited', pin: pinStub }))),
    },
  };
  return { channel, pinStub, sendPinStub };
}

describe('StatusCard', () => {
  it('adopt 后再次 initialize 会清空组件且不再重新 pin', async () => {
    const { channel, pinStub } = createChannel();
    const card = new StatusCard(channel as never);

    card.adopt('legacy');
    await card.initialize({ turn: 1, updatedAt: Date.now(), phase: 'phase' });

    const editFn = channel.messages.edit as ReturnType<typeof vi.fn>;
    expect(editFn).toHaveBeenCalledWith(
      'legacy',
      expect.objectContaining({ components: [] }),
    );
    expect(pinStub).not.toHaveBeenCalled();
  });

  it('编辑失败时回落到新消息且不再 pin', async () => {
    const sendPin = vi.fn(async () => undefined);
    const sendFn = vi.fn(async () => ({ id: 'fallback', pin: sendPin }));
    const editFn = vi.fn(async () => {
      throw new Error('not found');
    });
    const channel = {
      send: sendFn,
      messages: { edit: editFn },
    } as never;

    const card = new StatusCard(channel);
    card.adopt('legacy');
    await card.update('idle', { turn: 2, updatedAt: Date.now(), phase: 'phase2' });

    expect(sendFn).toHaveBeenCalled();
    expect(sendPin).not.toHaveBeenCalled();
    expect(card.getMessageId()).toBe('fallback');
  });

  it('可以把当前状态消息重建到频道底部并切换绑定', async () => {
    const sendFn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'initial' })
      .mockResolvedValueOnce({ id: 'bottom' });
    const channel = {
      send: sendFn,
      messages: {
        edit: vi.fn(async () => undefined),
      },
    } as never;

    const card = new StatusCard(channel);
    await card.initialize({ turn: 1, updatedAt: 1, phase: '待命' });

    const result = await card.recreateAtBottom();

    expect(result).toEqual({ oldMessageId: 'initial', newMessageId: 'bottom' });
    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(card.getMessageId()).toBe('bottom');
  });

  it('validate 会拒绝过长文本', () => {
    const { channel } = createChannel();
    const card = new StatusCard(channel as never);
    expect(() => card.validate('a'.repeat(201))).toThrow('状态卡描述过长');
  });

  it('validate 会拒绝代码块', () => {
    const { channel } = createChannel();
    const card = new StatusCard(channel as never);
    expect(() => card.validate('```js\nconst x = 1;\n```')).toThrow('代码块');
  });

  it('validate 会拒绝 diff', () => {
    const { channel } = createChannel();
    const card = new StatusCard(channel as never);
    expect(() => card.validate('diff --git a/src/index.ts b/src/index.ts')).toThrow();
  });

  it('validate 会拒绝文件列表', () => {
    const { channel } = createChannel();
    const card = new StatusCard(channel as never);
    const list = '- src/app.ts\n- src/lib/util.ts';
    expect(() => card.validate(list)).toThrow();
  });

  it('validate 允许简单阶段文本', () => {
    const { channel } = createChannel();
    const card = new StatusCard(channel as never);
    expect(() => card.validate('这一轮正在等待人工审批')).not.toThrow();
  });

  it('状态卡可以展示权限摘要', async () => {
    const sendFn = vi.fn(async (payload) => payload);
    const channel = {
      send: sendFn,
      messages: {
        edit: vi.fn(async () => undefined),
      },
    } as never;

    const card = new StatusCard(channel);
    await card.initialize({
      turn: 1,
      updatedAt: 1,
      phase: '待命',
      provider: 'codex',
      permissionsSummary: 'bypass',
    });

    const embed = sendFn.mock.calls[0]?.[0]?.embeds?.[0];
    expect(embed?.data?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '权限', value: 'bypass' })]),
    );
  });
});
