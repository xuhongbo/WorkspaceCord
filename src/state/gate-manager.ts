import { HumanGateRegistry, type HumanGateRecord } from './human-gate.ts';
import { EventBus } from '../core/event-bus.ts';
import type { ProviderName } from '../types.ts';

export interface CreateGateParams {
  sessionId: string;
  provider: ProviderName;
  type: 'binary_approval' | 'text_question' | 'notification';
  isBlocking: boolean;
  supportsRemoteDecision: boolean;
  summary: string;
  detail?: string;
  relatedCommand?: string;
  turn: number;
}

export interface ReceiptHandle {
  type: ProviderName;
  sessionId: string;
  resolve: (action: string, source: string) => void;
  reject: (reason: string) => void;
}

export interface InvalidatedGate {
  gateId: string;
  sessionId: string;
  discordMessageId?: string;
}

export class GateManager {
  #registry: HumanGateRegistry;
  #eventBus: EventBus;
  #receiptHandles = new Map<string, ReceiptHandle>();
  #receiptTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(registry: HumanGateRegistry, eventBus: EventBus) {
    this.#registry = registry;
    this.#eventBus = eventBus;
  }

  createGate(params: CreateGateParams): HumanGateRecord {
    const gate = this.#registry.create({
      sessionId: params.sessionId,
      provider: params.provider,
      type: params.type,
      isBlocking: params.isBlocking,
      supportsRemoteDecision: params.supportsRemoteDecision,
      summary: params.summary,
      detail: params.detail,
      relatedCommand: params.relatedCommand,
      turn: params.turn,
    });

    this.#eventBus.emit('gate.created' as any, { gate, gateId: gate.id }, 'gate-manager');
    return gate;
  }

  getGate(id: string): HumanGateRecord | undefined {
    return this.#registry.get(id);
  }

  bindDiscordMessage(gateId: string, messageId: string): boolean {
    const gate = this.#registry.get(gateId);
    if (!gate || gate.status !== 'pending') return false;

    const result = this.#registry.update(gateId, gate.version, { discordMessageId: messageId });
    return result.success;
  }

  async resolveGateFromDiscord(
    gateId: string,
    action: 'approve' | 'reject',
  ): Promise<{ success: boolean; message?: string }> {
    const gate = this.#registry.get(gateId);
    if (!gate) {
      return { success: false, message: 'Gate not found' };
    }

    if (gate.status !== 'pending') {
      return { success: false, message: '门控已被处理' };
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    const result = this.#registry.update(gateId, gate.version, {
      status,
      resolvedAt: Date.now(),
      resolvedBy: 'discord',
      resolvedAction: action,
    });

    if (!result.success) {
      return { success: false, message: result.message };
    }

    this.#eventBus.emit('gate.resolved' as any, {
      gateId,
      status,
      resolvedBy: 'discord',
      resolvedAction: action,
    }, 'gate-manager');

    // Resolve any pending receipt handle
    const handle = this.#receiptHandles.get(gateId);
    if (handle) {
      this.#clearReceiptTimeout(gateId);
      this.#receiptHandles.delete(gateId);
      handle.resolve(action, 'discord');
    }

    return { success: true };
  }

  registerReceiptHandle(gateId: string, handle: ReceiptHandle): void {
    this.#receiptHandles.set(gateId, handle);

    // Set timeout to reject the handle after 5 minutes
    const timeout = setTimeout(() => {
      const h = this.#receiptHandles.get(gateId);
      if (h) {
        this.#receiptHandles.delete(gateId);
        h.reject('timeout');
      }
    }, 5 * 60 * 1000);

    this.#receiptTimeouts.set(gateId, timeout);
  }

  invalidateAllOnRestart(): InvalidatedGate[] {
    const invalidated: InvalidatedGate[] = [];

    for (const gate of this.#registry.getAll()) {
      if (gate.status === 'pending') {
        invalidated.push({
          gateId: gate.id,
          sessionId: gate.sessionId,
          discordMessageId: gate.discordMessageId,
        });
      }
    }

    this.#registry.invalidateAll('restart');

    // Reject all pending receipt handles
    for (const [gateId, handle] of this.#receiptHandles) {
      this.#clearReceiptTimeout(gateId);
      handle.reject('restart');
    }
    this.#receiptHandles.clear();

    return invalidated;
  }

  getActiveGateForSession(sessionId: string): HumanGateRecord | undefined {
    const active = this.#registry.getActiveBySession(sessionId);
    return active.length > 0 ? active[0] : undefined;
  }

  cleanupExpired(maxAgeMs: number = 5 * 60 * 1000): number {
    const count = this.#registry.cleanupExpired(maxAgeMs);

    // Expire receipt handles for cleaned-up gates
    const now = Date.now();
    for (const gate of this.#registry.getAll()) {
      if (gate.status === 'expired') {
        const handle = this.#receiptHandles.get(gate.id);
        if (handle) {
          this.#clearReceiptTimeout(gate.id);
          this.#receiptHandles.delete(gate.id);
          handle.reject('timeout');
        }
      }
    }

    return count;
  }

  getAllGates(): HumanGateRecord[] {
    return this.#registry.getAll();
  }

  archiveResolved(keepCount: number = 100): number {
    return this.#registry.archiveResolved(keepCount);
  }

  #clearReceiptTimeout(gateId: string): void {
    const timeout = this.#receiptTimeouts.get(gateId);
    if (timeout) {
      clearTimeout(timeout);
      this.#receiptTimeouts.delete(gateId);
    }
  }
}
