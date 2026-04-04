import type { ThreadSession, ProviderName } from '../types.ts';
import type { SessionManager } from './session-manager.ts';

/**
 * Read-only session query interface.
 * Delegates to SessionManager for all reads — no direct mutation.
 */
export class SessionLookup {
  constructor(private sessionManager: SessionManager) {}

  /** Get all sessions. */
  getAll(): ThreadSession[] {
    return this.sessionManager.getAll();
  }

  /** Get active (generating) sessions. */
  getActive(): ThreadSession[] {
    return this.sessionManager.getActive();
  }

  /** Get session by channel ID. */
  getByChannel(channelId: string): ThreadSession | undefined {
    return this.sessionManager.getByChannel(channelId);
  }

  /** Get session by session ID. */
  getById(sessionId: string): ThreadSession | undefined {
    return this.sessionManager.getById(sessionId);
  }

  /** Get sessions by project. */
  getByProject(projectName: string): ThreadSession[] {
    return this.sessionManager.getAll().filter((s) => (s as unknown as Record<string, unknown>).projectName === projectName);
  }

  /** Get sessions by provider. */
  getByProvider(provider: ProviderName): ThreadSession[] {
    return this.sessionManager.getAll().filter((s) => s.provider === provider);
  }

  /** Get session count. */
  get count(): number {
    return this.sessionManager.count;
  }

  /** Get stats summary. */
  getStats(): {
    total: number;
    active: number;
    byProvider: Record<string, number>;
  } {
    const all = this.getAll();
    const byProvider: Record<string, number> = {};
    for (const s of all) {
      byProvider[s.provider] = (byProvider[s.provider] || 0) + 1;
    }
    return {
      total: all.length,
      active: this.sessionManager.getActive().length,
      byProvider,
    };
  }
}
