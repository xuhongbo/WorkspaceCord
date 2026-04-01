import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SummaryHandler } from '../src/discord/summary-handler.ts';

function createChannel() {
  let nextId = 1;
  return {
    send: vi.fn(async () => ({ id: `m${nextId++}` })),
    messages: {
      edit: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
  };
}

describe('SummaryHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('摘要分片后刷新时复用已有消息而不是重复新发', async () => {
    const channel = createChannel();
    const statusCard = { update: vi.fn(async () => undefined) };
    const handler = new SummaryHandler(channel as never, statusCard as never);

    await handler.sendDigestSummary('A'.repeat(2500));
    expect(channel.send).toHaveBeenCalledTimes(2);

    await handler.sendDigestSummary('B'.repeat(2500));
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.messages.edit).toHaveBeenCalledTimes(2);
  });
});
