import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogBuffer } from '../src/bot-log-buffer.ts';

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    config: {
      textChunkLimit: 2000,
      chunkMode: 'none',
      replyToMode: 'off',
      ackReaction: false,
    },
  };
});

vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan: vi.fn(() => ({ plan: 'mock' })),
}));

const mockDeliver = vi.fn();
vi.mock('../src/discord/delivery.ts', () => ({
  get deliver() { return mockDeliver; },
}));

describe('LogBuffer', () => {
  let buffer: LogBuffer;
  let mockChannel: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    buffer = new LogBuffer();

    mockChannel = {
      id: 'log-channel-1',
      send: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('log', () => {
    it('adds message to buffer and schedules flush timer', () => {
      buffer.setChannel(mockChannel);
      buffer.log('test message');

      // Timer should be scheduled, delivery not yet called
      expect(mockDeliver).not.toHaveBeenCalled();

      // Advance timer to trigger the scheduled flush
      vi.advanceTimersByTime(2000);
      vi.advanceTimersToNextTimer();

      expect(mockDeliver).toHaveBeenCalledOnce();
    });

    it('dedupes multiple logs into single flush', () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg1');
      buffer.log('msg2');
      buffer.log('msg3');

      expect(mockDeliver).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);
      vi.advanceTimersToNextTimer();

      expect(mockDeliver).toHaveBeenCalledOnce();
    });
  });

  describe('flush', () => {
    it('does nothing without channel', async () => {
      buffer.log('msg');
      await buffer.flush();
      expect(mockDeliver).not.toHaveBeenCalled();
    });

    it('does nothing with empty buffer', async () => {
      buffer.setChannel(mockChannel);
      await buffer.flush();
      expect(mockDeliver).not.toHaveBeenCalled();
    });

    it('delivers all buffered messages in one call', async () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg1');
      buffer.log('msg2');

      await buffer.flush();

      expect(mockDeliver).toHaveBeenCalledOnce();
    });

    it('clears buffer after flush so second flush is empty', async () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg');
      await buffer.flush();

      expect(mockDeliver).toHaveBeenCalledOnce();

      mockDeliver.mockClear();
      await buffer.flush();

      expect(mockDeliver).not.toHaveBeenCalled();
    });
  });
});
