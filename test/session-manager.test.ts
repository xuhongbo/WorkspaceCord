import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/session/session-manager.ts';
import { EventBus } from '../src/core/event-bus.ts';

vi.mock('../src/persistence.ts', () => ({
  Store: class {
    private data: any[] = [];
    async read() { return this.data.length ? this.data : null; }
    async write(d: any[]) { this.data = d; }
  },
}));

function makeCreateParams(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sess-1',
    channelId: 'ch-1',
    categoryId: 'cat-1',
    provider: 'claude' as const,
    mode: 'auto' as const,
    label: 'test-session',
    ...overrides,
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new SessionManager(eventBus);
  });

  describe('create', () => {
    it('creates a session with given params', () => {
      const session = manager.create(makeCreateParams());

      expect(session.id).toBe('sess-1');
      expect(session.channelId).toBe('ch-1');
      expect(session.categoryId).toBe('cat-1');
      expect(session.provider).toBe('claude');
      expect(session.mode).toBe('auto');
      expect(session.isGenerating).toBe(false);
    });

    it('emits session.created event', () => {
      const handler = vi.fn();
      eventBus.on('session.created' as never, handler);

      manager.create(makeCreateParams());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.sessionId).toBe('sess-1');
    });

    it('uses defaults for optional fields', () => {
      const session = manager.create(makeCreateParams({ projectName: undefined, cwd: undefined }));

      expect(session.projectName).toBe('');
      expect((session as any).directory).toBe('');
    });
  });

  describe('getByChannel / getById', () => {
    it('finds session by channel ID', () => {
      manager.create(makeCreateParams());

      const found = manager.getByChannel('ch-1');
      expect(found?.id).toBe('sess-1');
    });

    it('finds session by session ID', () => {
      manager.create(makeCreateParams());

      const found = manager.getById('sess-1');
      expect(found?.channelId).toBe('ch-1');
    });

    it('returns undefined for missing channel', () => {
      expect(manager.getByChannel('nonexistent')).toBeUndefined();
    });

    it('returns undefined for missing session ID', () => {
      expect(manager.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('end', () => {
    it('marks session as not generating and updates lastActivity', () => {
      manager.create(makeCreateParams());

      const ended = manager.end('ch-1');
      expect(ended?.isGenerating).toBe(false);
    });

    it('emits session.ended event', () => {
      const handler = vi.fn();
      eventBus.on('session.ended' as never, handler);
      manager.create(makeCreateParams());

      manager.end('ch-1');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns undefined for missing channel', () => {
      expect(manager.end('nonexistent')).toBeUndefined();
    });
  });

  describe('updateState', () => {
    it('applies updates and sets lastActivity', () => {
      manager.create(makeCreateParams());

      const updated = manager.updateState('ch-1', { isGenerating: true });
      expect(updated?.isGenerating).toBe(true);
    });

    it('emits session.state_changed with previous and current', () => {
      const handler = vi.fn();
      eventBus.on('session.state_changed' as never, handler);
      manager.create(makeCreateParams());

      manager.updateState('ch-1', { isGenerating: true });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.payload.previous.isGenerating).toBe(false);
      expect(event.payload.current.isGenerating).toBe(true);
    });

    it('returns undefined for missing channel', () => {
      expect(manager.updateState('nonexistent', { isGenerating: true })).toBeUndefined();
    });
  });

  describe('getByCategory / getAll / getActive', () => {
    it('filters sessions by category', () => {
      manager.create(makeCreateParams({ channelId: 'ch-1', categoryId: 'cat-1' }));
      manager.create(makeCreateParams({ channelId: 'ch-2', categoryId: 'cat-2' }));

      expect(manager.getByCategory('cat-1')).toHaveLength(1);
      expect(manager.getByCategory('cat-2')).toHaveLength(1);
    });

    it('returns all sessions', () => {
      manager.create(makeCreateParams({ channelId: 'ch-1' }));
      manager.create(makeCreateParams({ channelId: 'ch-2' }));

      expect(manager.getAll()).toHaveLength(2);
    });

    it('returns only generating sessions as active', () => {
      manager.create(makeCreateParams({ channelId: 'ch-1' }));
      manager.create(makeCreateParams({ channelId: 'ch-2' }));
      manager.updateState('ch-1', { isGenerating: true });

      expect(manager.getActive()).toHaveLength(1);
      expect(manager.getActive()[0].channelId).toBe('ch-1');
    });
  });

  describe('remove', () => {
    it('removes session from memory', async () => {
      manager.create(makeCreateParams());
      expect(manager.count).toBe(1);

      await manager.remove('ch-1');
      expect(manager.count).toBe(0);
    });

    it('returns false for missing channel', async () => {
      expect(await manager.remove('nonexistent')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns number of sessions', () => {
      expect(manager.count).toBe(0);
      manager.create(makeCreateParams({ channelId: 'ch-1' }));
      expect(manager.count).toBe(1);
    });
  });
});
