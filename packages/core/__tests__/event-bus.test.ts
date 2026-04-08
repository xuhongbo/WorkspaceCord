import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../src/event-bus.ts';
import type { AppEvent, EventType } from '../src/events.ts';

// Type helper to cast string to EventType<T>
function et<T>(type: string): EventType<T> {
  return type as EventType<T>;
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('emit / on', () => {
    it('delivers events to registered handlers', () => {
      const handler = vi.fn();
      bus.on(et<{ value: number }>('test.event'), handler);
      bus.emit(et('test.event'), { value: 42 });

      expect(handler).toHaveBeenCalledTimes(1);
      const event: AppEvent = handler.mock.calls[0][0];
      expect(event.type).toBe('test.event');
      expect(event.payload).toEqual({ value: 42 });
    });

    it('auto-generates traceId and timestamp', () => {
      const handler = vi.fn();
      bus.on(et('test.event'), handler);
      bus.emit(et('test.event'), {});

      const event: AppEvent = handler.mock.calls[0][0];
      expect(event.traceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('sets source from emit parameter', () => {
      const handler = vi.fn();
      bus.on(et('test.event'), handler);
      bus.emit(et('test.event'), {}, 'test-source');

      const event: AppEvent = handler.mock.calls[0][0];
      expect(event.source).toBe('test-source');
    });

    it('defaults source to unknown', () => {
      const handler = vi.fn();
      bus.on(et('test.event'), handler);
      bus.emit(et('test.event'), {});

      const event: AppEvent = handler.mock.calls[0][0];
      expect(event.source).toBe('unknown');
    });
  });

  describe('once', () => {
    it('fires handler only once', () => {
      const handler = vi.fn();
      bus.once(et('once.event'), handler);

      bus.emit(et('once.event'), { n: 1 });
      bus.emit(et('once.event'), { n: 2 });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as AppEvent<{ n: number }>;
      expect(event.payload.n).toBe(1);
    });
  });

  describe('off', () => {
    it('removes handler', () => {
      const handler = vi.fn();
      bus.on(et('test.event'), handler);
      bus.off(et('test.event'), handler);
      bus.emit(et('test.event'), {});

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('middleware', () => {
    it('runs middleware before handlers', async () => {
      const order: string[] = [];
      bus.middleware(() => {
        order.push('middleware');
      });
      bus.on(et('test.event'), () => {
        order.push('handler');
      });

      bus.emit(et('test.event'), {});
      // Small delay for async middleware
      await new Promise((r) => setTimeout(r, 10));

      expect(order).toEqual(['middleware', 'handler']);
    });

    it('middleware errors are logged but do not stop propagation', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const handler = vi.fn();

      bus.middleware(() => {
        throw new Error('middleware error');
      });
      bus.on(et('test.event'), handler);

      bus.emit(et('test.event'), {});
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it('middleware can mutate event', async () => {
      bus.middleware((event) => {
        (event.payload as Record<string, unknown>).enriched = true;
      });

      const handler = vi.fn();
      bus.on(et<{ original: boolean }>('test.event'), handler);
      bus.emit(et('test.event'), { original: true });
      await new Promise((r) => setTimeout(r, 10));

      const event: AppEvent = handler.mock.calls[0][0];
      expect(event.payload).toHaveProperty('enriched', true);
      expect(event.payload).toHaveProperty('original', true);
    });
  });

  describe('multiple handlers', () => {
    it('delivers to all registered handlers', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();

      bus.on(et('multi.event'), h1);
      bus.on(et('multi.event'), h2);
      bus.on(et('multi.event'), h3);

      bus.emit(et('multi.event'), { data: 'test' });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      expect(h3).toHaveBeenCalledTimes(1);
    });
  });
});
