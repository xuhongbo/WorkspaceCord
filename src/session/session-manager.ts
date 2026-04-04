import type { ThreadSession, SessionPersistData, ProviderName, SessionMode } from '../types.ts';
import type { EventBus } from '../core/event-bus.ts';
import { SessionStore } from './session-store.ts';

export interface CreateSessionParams {
  sessionId: string;
  channelId: string;
  categoryId: string;
  provider: ProviderName;
  mode: SessionMode;
  label: string;
  projectName?: string;
  cwd?: string;
  parentChannelId?: string;
}

function makePersistData(params: CreateSessionParams, now: number): SessionPersistData {
  return {
    id: params.sessionId,
    channelId: params.channelId,
    categoryId: params.categoryId,
    provider: params.provider,
    mode: params.mode,
    label: params.label,
    projectName: params.projectName || '',
    directory: params.cwd || '',
    parentChannelId: params.parentChannelId,
    createdAt: now,
    lastActivity: now,
    messageCount: 0,
    totalCost: 0,
    workflowState: {
      status: 'idle',
      iteration: 0,
      updatedAt: now,
    },
    isGenerating: false,
    verbose: false,
    currentTurn: 0,
    humanResolved: false,
    subagentDepth: 0,
    type: 'claude',
    agentLabel: params.label,
  } as unknown as SessionPersistData;
}

function toThreadSession(data: SessionPersistData): ThreadSession {
  return data as unknown as ThreadSession;
}

/**
 * Unified SessionManager facade.
 * Coordinates session CRUD, persistence, and event emission.
 * Delegates storage to SessionStore.
 */
export class SessionManager {
  #store: SessionStore;
  #eventBus: EventBus;
  #sessions = new Map<string, ThreadSession>();

  constructor(eventBus: EventBus, store?: SessionStore) {
    this.#eventBus = eventBus;
    this.#store = store || new SessionStore();
  }

  /** Load sessions from persistence. */
  async loadAll(): Promise<ThreadSession[]> {
    const data = await this.#store.load();
    for (const s of data) {
      if (s.channelId && s.categoryId) {
        this.#sessions.set(s.channelId, toThreadSession(s));
      }
    }
    return Array.from(this.#sessions.values());
  }

  /** Create a new session and persist it. */
  create(params: CreateSessionParams): ThreadSession {
    const now = Date.now();
    const persistData = makePersistData(params, now);
    const session = toThreadSession(persistData);

    this.#sessions.set(params.channelId, session);

    this.#store.saveDebounced(persistData);

    this.#eventBus.emit('session.created' as never, {
      session,
      sessionId: session.id,
    }, 'session-manager');

    return session;
  }

  /** End a session (mark as completed). */
  end(channelId: string): ThreadSession | undefined {
    const session = this.#sessions.get(channelId);
    if (!session) return undefined;

    (session as unknown as Record<string, unknown>).lastActivity = Date.now();
    session.isGenerating = false;

    this.#store.saveDebounced(session as unknown as SessionPersistData);

    this.#eventBus.emit('session.ended' as never, {
      sessionId: session.id,
      channelId,
    }, 'session-manager');

    return session;
  }

  /** Update session state and emit state_changed event. */
  updateState(channelId: string, updates: Partial<ThreadSession>): ThreadSession | undefined {
    const session = this.#sessions.get(channelId);
    if (!session) return undefined;

    const previous = { ...session };
    Object.assign(session, updates, { lastActivity: Date.now() });

    this.#store.saveDebounced(session as unknown as SessionPersistData);

    this.#eventBus.emit('session.state_changed' as never, {
      sessionId: session.id,
      channelId,
      previous,
      current: session,
    }, 'session-manager');

    return session;
  }

  /** Get session by channel ID. */
  getByChannel(channelId: string): ThreadSession | undefined {
    return this.#sessions.get(channelId);
  }

  /** Get session by ID. */
  getById(sessionId: string): ThreadSession | undefined {
    return Array.from(this.#sessions.values()).find((s) => s.id === sessionId);
  }

  /** Get all sessions in a category. */
  getByCategory(categoryId: string): ThreadSession[] {
    return Array.from(this.#sessions.values()).filter((s) => s.categoryId === categoryId);
  }

  /** Get all sessions. */
  getAll(): ThreadSession[] {
    return Array.from(this.#sessions.values());
  }

  /** Get active (generating) sessions. */
  getActive(): ThreadSession[] {
    return Array.from(this.#sessions.values()).filter((s) => s.isGenerating);
  }

  /** Remove session from memory and storage. */
  async remove(channelId: string): Promise<boolean> {
    const session = this.#sessions.get(channelId);
    if (!session) return false;

    this.#sessions.delete(channelId);
    await this.#store.delete(session.id);

    return true;
  }

  /** Get session count. */
  get count(): number {
    return this.#sessions.size;
  }
}
