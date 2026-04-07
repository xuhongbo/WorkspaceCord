import type { SessionStateProjection } from '../state/types.ts';

export interface StatusCardProjectionContext {
  statusCard: {
    update(
      state: SessionStateProjection['state'],
      data: {
        turn: number;
        updatedAt: number;
        phase?: string;
        remoteHumanControl?: boolean;
        provider?: 'claude' | 'codex';
        permissionsSummary?: string;
      },
    ): Promise<void>;
  };
  remoteHumanControl?: boolean;
  provider?: 'claude' | 'codex';
  permissionsSummary?: string;
}

export class StatusCardProjectionRenderer {
  #pending = new Map<string, NodeJS.Timeout>();

  async renderNow(
    sessionId: string,
    projection: SessionStateProjection,
    context: StatusCardProjectionContext | undefined,
  ): Promise<void> {
    if (!context) return;

    try {
      await context.statusCard.update(projection.state, {
        turn: projection.turn,
        updatedAt: projection.updatedAt,
        phase: projection.phase,
        remoteHumanControl: context.remoteHumanControl,
        provider: context.provider,
        permissionsSummary: context.permissionsSummary,
      });
    } catch (error) {
      console.error(`状态卡更新失败 (${sessionId}):`, error);
    }
  }

  schedule(
    sessionId: string,
    projection: SessionStateProjection,
    context: StatusCardProjectionContext | undefined,
    delayMs: number,
    onComplete?: () => void,
  ): void {
    const pending = this.#pending.get(sessionId);
    if (pending) {
      clearTimeout(pending);
    }

    const timer = setTimeout(async () => {
      await this.renderNow(sessionId, projection, context);
      this.#pending.delete(sessionId);
      onComplete?.();
    }, delayMs);

    this.#pending.set(sessionId, timer);
  }

  clear(sessionId: string): void {
    const pending = this.#pending.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.#pending.delete(sessionId);
    }
  }

  clearAll(): void {
    for (const timer of this.#pending.values()) {
      clearTimeout(timer);
    }
    this.#pending.clear();
  }

  getPendingCount(): number {
    return this.#pending.size;
  }
}
