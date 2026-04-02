import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildDeliveryPlan = vi.fn();
const deliver = vi.fn();

vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan,
}));

vi.mock('../src/discord/delivery.ts', () => ({
  deliver,
}));

vi.mock('../src/config.ts', () => ({
  config: {
    textChunkLimit: 2000,
    chunkMode: 'length',
    replyToMode: 'first',
    ackReaction: '👀',
  },
}));

describe('hook-health notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildDeliveryPlan.mockImplementation((input) => ({
      sessionId: input.sessionId,
      chatId: input.chatId,
      chunks: [input.text],
      filesOnFirstChunk: input.files,
      mode: input.mode,
    }));
    deliver.mockResolvedValue(['msg-1']);
  });

  it('通过统一投递层发送健康检查通知', async () => {
    const { sendHookHealthNotification } = await import('../src/hook-health-check.ts');
    const channel = { id: 'log-1', send: vi.fn() };
    const client = {
      channels: { cache: { get: vi.fn(() => channel) } },
    };

    await sendHookHealthNotification(
      client as never,
      { isHealthy: false, issues: ['缺少钩子'], warnings: ['日志存在'] },
      'log-1',
    );

    expect(buildDeliveryPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'log-1',
        mode: 'system_notice',
        text: expect.stringContaining('缺少钩子'),
      }),
    );
    expect(deliver).toHaveBeenCalledWith(channel, expect.objectContaining({ mode: 'system_notice' }));
    expect(channel.send).not.toHaveBeenCalled();
  });
});
