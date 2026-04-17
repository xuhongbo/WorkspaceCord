import type { HumanGateRecord } from './human-gate.ts';
import type { GateService } from './gate-service.ts';

export interface SessionStateSummary {
  sessionId: string;
  activeGateCount: number;
  totalGateCount: number;
  hasPendingGates: boolean;
  latestGate?: HumanGateRecord;
}

export interface GateStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
  invalidated: number;
}

/**
 * Read-only state query interface.
 * Delegates to GateService for all reads — no direct mutation.
 */
export class StateLookup {
  private readonly gateService: GateService;

  constructor(gateService: GateService) {
    this.gateService = gateService;
  }

  getActiveGates(): HumanGateRecord[] {
    return this.gateService.getAllGates().filter((g) => g.status === 'pending');
  }

  getGatesBySession(sessionId: string): HumanGateRecord[] {
    return this.gateService.getAllGates().filter((g) => g.sessionId === sessionId);
  }

  getGateStats(): GateStats {
    const all = this.gateService.getAllGates();
    return {
      total: all.length,
      pending: all.filter((g) => g.status === 'pending').length,
      approved: all.filter((g) => g.status === 'approved').length,
      rejected: all.filter((g) => g.status === 'rejected').length,
      expired: all.filter((g) => g.status === 'expired').length,
      invalidated: all.filter((g) => g.status === 'invalidated').length,
    };
  }

  getSessionState(sessionId: string): SessionStateSummary {
    const gates = this.getGatesBySession(sessionId);
    const active = gates.filter((g) => g.status === 'pending');
    const sorted = [...gates].sort((a, b) => b.createdAt - a.createdAt);

    return {
      sessionId,
      activeGateCount: active.length,
      totalGateCount: gates.length,
      hasPendingGates: active.length > 0,
      latestGate: sorted[0],
    };
  }
}
