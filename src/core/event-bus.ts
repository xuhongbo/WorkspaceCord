import { EventEmitter } from 'node:events';
import type {
  AppEvent,
  EventMap,
  EventHandler,
  EventMiddleware,
  EventType,
} from './events.ts';
// ── Type-safe key helper ─────────────────────────────────────────────────────

function key<T>(eventType: EventType<T>): string {
  return eventType;
}

// ── EventBus ──────────────────────────────────────────────────────────────────

export class EventBus extends EventEmitter {
  #middleware: EventMiddleware[] = [];

  constructor() {
    super({ captureRejections: false });
    this.setMaxListeners(Infinity);
  }

  /**
   * Emit an event. Automatically generates traceId, timestamp, and source.
   * Middleware runs before any handlers. Middleware errors are logged but
   * do not stop propagation.
   */
  emit<T>(eventType: EventType<T>, payload: T, source = 'unknown'): boolean {
    const event: AppEvent<T> = {
      type: key(eventType),
      payload,
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
      source,
    };

    // Run middleware (async-aware, errors logged but don't block)
    const middlewarePromises = this.#middleware.map(async (fn) => {
      try {
        await fn(event as AppEvent);
      } catch (err) {
        console.error('[EventBus] middleware error:', err);
      }
    });

    // Fire-and-forget middleware so emit stays synchronous from the caller's
    // perspective, but handlers still receive the event immediately.
    void Promise.allSettled(middlewarePromises);

    return super.emit(key(eventType), event);
  }

  /** Register a handler for the given event type. */
  on<T>(eventType: EventType<T>, handler: EventHandler<T>): this {
    return super.on(key(eventType), handler as (...args: unknown[]) => void);
  }

  /** Register a one-shot handler for the given event type. */
  once<T>(eventType: EventType<T>, handler: EventHandler<T>): this {
    return super.once(key(eventType), handler as (...args: unknown[]) => void);
  }

  /** Remove a previously registered handler. */
  off<T>(eventType: EventType<T>, handler: EventHandler<T>): this {
    return super.off(key(eventType), handler as (...args: unknown[]) => void);
  }

  /**
   * Register middleware that runs before every handler.
   * Middleware receives the raw AppEvent and can mutate it.
   * Errors are caught and logged — they do not stop propagation.
   */
  middleware(fn: EventMiddleware): void {
    this.#middleware.push(fn);
  }
}
