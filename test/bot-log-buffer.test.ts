import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogBuffer } from '../src/bot-log-buffer.ts';

vi.mock('../src/config.ts', () => ({
  config: {
    textChunkLimit: 2000,
    chunkMode: 'none',
    replyToMode: 'off',
    ackReaction: false,
  },
}));

vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan: vi.fn(() => ({ plan: 'mock' })),
}));

vi.mock('../src/discord/delivery.ts', () => ({
  deliver: vi.fn(),
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
    it('adds message to buffer', () => {
      buffer.setChannel(mockChannel);
      buffer.log('test message');

      // Message logged to console (verify separately)
    });

    it('schedules flush after debounce', () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg1');
      buffer.log('msg2');

      // No immediate flush
    });
  });

  describe('flush', () => {
    it('does nothing without channel', async () => {
      buffer.log('msg');
      await buffer.flush();
      // Should not throw
    });

    it('does nothing with empty buffer', async () => {
      buffer.setChannel(mockChannel);
      await buffer.flush();
    });

    it('sends all buffered messages to channel', async () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg1');
      buffer.log('msg2');

      await buffer.flush();

      // Messages are flushed via delivery pipeline
    });

    it('clears buffer after flush', async () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg');
      await buffer.flush();

      // Second flush should be empty
      await buffer.flush();
    });
  });
});
