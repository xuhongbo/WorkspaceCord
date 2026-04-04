import { Store } from '../persistence.ts';
import type { SessionPersistData } from '../types.ts';

/**
 * Session persistence layer with debounced and immediate save.
 * Wraps the JSON file Store with debounced writes to reduce I/O.
 */
export class SessionStore {
  #store: Store<SessionPersistData[]>;
  #buffer = new Map<string, SessionPersistData>();
  #saveQueue: Promise<void> = Promise.resolve();
  #debounceTimer: NodeJS.Timeout | null = null;
  readonly DEBOUNCE_MS = 100;

  constructor(storeName = 'sessions.json') {
    this.#store = new Store<SessionPersistData[]>(storeName);
  }

  /** Load all sessions from disk. Returns empty array if not found. */
  async load(): Promise<SessionPersistData[]> {
    const data = await this.#store.read();
    return data ?? [];
  }

  /** Save a single session immediately (bypass debounce). */
  async saveImmediate(session: SessionPersistData): Promise<void> {
    this.#buffer.set(session.id, session);
    await this.#flush();
  }

  /** Save a single session with debounce. Multiple saves within DEBOUNCE_MS are batched. */
  saveDebounced(session: SessionPersistData): void {
    this.#buffer.set(session.id, session);
    this.#scheduleFlush();
  }

  /** Delete a session from storage. Chains behind #saveQueue to prevent
   *  race with in-flight debounced flush that could resurrect the record. */
  async delete(sessionId: string): Promise<void> {
    this.#buffer.delete(sessionId);
    // Chain behind saveQueue to prevent race with in-flight flush
    this.#saveQueue = this.#saveQueue.then(async () => {
      const sessions = await this.load();
      const filtered = sessions.filter((s) => s.id !== sessionId);
      await this.#store.write(filtered);
    });
    return this.#saveQueue;
  }

  /** Flush all buffered saves to disk. */
  async flush(): Promise<void> {
    return this.#flush();
  }

  async #flush(): Promise<void> {
    this.#saveQueue = this.#saveQueue.then(async () => {
      const sessions = await this.load();
      const map = new Map(sessions.map((s) => [s.id, s]));

      for (const [id, data] of this.#buffer) {
        map.set(id, data);
      }

      this.#buffer.clear();
      await this.#store.write(Array.from(map.values()));
    }).catch((err) => {
      console.error('[SessionStore] Save failed:', err);
    });

    return this.#saveQueue;
  }

  #scheduleFlush(): void {
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#flush();
    }, this.DEBOUNCE_MS);
  }
}
