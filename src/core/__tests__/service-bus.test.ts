import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceBus, intervalService, type Service, type ServiceHealth } from '../service-bus.ts';

function createMockService(name: string, opts: { startThrows?: boolean; stopThrows?: boolean; healthStatus?: ServiceHealth['status'] } = {}): Service & { startCount: number; stopCount: number } {
  return {
    name,
    startCount: 0,
    stopCount: 0,
    async start() {
      this.startCount++;
      if (opts.startThrows) throw new Error('start failed');
    },
    async stop() {
      this.stopCount++;
      if (opts.stopThrows) throw new Error('stop failed');
    },
    health(): ServiceHealth {
      return { status: opts.healthStatus ?? 'healthy' };
    },
  };
}

describe('ServiceBus', () => {
  let bus: ServiceBus;

  beforeEach(() => {
    bus = new ServiceBus();
  });

  describe('register', () => {
    it('registers a service', () => {
      const svc = createMockService('test');
      bus.register(svc);
      expect(bus.size).toBe(1);
    });

    it('throws on duplicate registration', () => {
      const svc = createMockService('test');
      bus.register(svc);
      expect(() => bus.register(svc)).toThrow('Service "test" is already registered');
    });
  });

  describe('startAll / stopAll', () => {
    it('starts all services in order', async () => {
      const a = createMockService('a');
      const b = createMockService('b');
      bus.register(a);
      bus.register(b);

      await bus.startAll();

      expect(a.startCount).toBe(1);
      expect(b.startCount).toBe(1);
    });

    it('stops all services in reverse order', async () => {
      const a = createMockService('a');
      const b = createMockService('b');
      bus.register(a);
      bus.register(b);

      await bus.startAll();
      await bus.stopAll();

      expect(a.stopCount).toBe(1);
      expect(b.stopCount).toBe(1);
    });

    it('continues starting if one service fails', async () => {
      const a = createMockService('a');
      const b = createMockService('b', { startThrows: true });
      const c = createMockService('c');
      bus.register(a);
      bus.register(b);
      bus.register(c);

      await bus.startAll();

      expect(a.startCount).toBe(1);
      expect(b.startCount).toBe(1);
      expect(c.startCount).toBe(1);
    });

    it('continues stopping if one service fails', async () => {
      const a = createMockService('a');
      const b = createMockService('b', { stopThrows: true });
      bus.register(a);
      bus.register(b);

      await bus.startAll();
      await bus.stopAll();

      expect(a.stopCount).toBe(1);
      expect(b.stopCount).toBe(1);
    });
  });

  describe('healthCheck', () => {
    it('returns health for all services', async () => {
      const a = createMockService('a', { healthStatus: 'healthy' });
      const b = createMockService('b', { healthStatus: 'degraded' });
      bus.register(a);
      bus.register(b);

      const health = await bus.healthCheck();

      expect(health.get('a')?.status).toBe('healthy');
      expect(health.get('b')?.status).toBe('degraded');
    });

    it('uses started status for services without health method', async () => {
      const svc: Service = {
        name: 'basic',
        start() {},
        stop() {},
      };
      bus.register(svc);

      await bus.startAll();
      const health = await bus.healthCheck();

      expect(health.get('basic')?.status).toBe('healthy');
    });
  });

  describe('intervalService', () => {
    it('creates a service that runs on interval', async () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      const svc = intervalService('ticker', fn, 100);

      svc.start();
      vi.advanceTimersByTime(250);

      expect(fn).toHaveBeenCalledTimes(2);

      svc.stop();
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});
