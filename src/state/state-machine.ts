// 统一状态机
// 单一真相源：只维护 StateMachineState，不再维护兼容态快照存储

import type { UnifiedState, SessionStateProjection, SessionPanelProjection, PlatformEvent } from './types.ts';
import { STATE_PRIORITY, STATE_LABELS, PLATFORM_EVENT_TO_STATE } from './types.ts';
import type {
  SessionLifecycle,
  ExecutionState,
  StateMachineState,
  StateTransition,
  TransitionUpdates,
  TransitionMetadata,
} from './types.ts';
import {
  toProjection,
  toPanelProjection,
  resolveDisplayState,
  getStateLabel,
  getStateColor,
} from './state-projections.ts';
import { mapEventToTransition } from './state-event-mapper.ts';

// Re-export types so existing `import { ... } from './state-machine.ts'` keeps working
export type {
  SessionLifecycle,
  ExecutionState,
  GateStatus,
  StateMachineState,
  StateTransition,
  TransitionUpdates,
  TransitionMetadata,
} from './types.ts';

// Re-export functions from sub-modules
export { toProjection, toPanelProjection, resolveDisplayState, getStateLabel, getStateColor } from './state-projections.ts';
export { mapEventToTransition } from './state-event-mapper.ts';

// ─── Transition tables ───────────────────────────────────────────────────────

const LIFECYCLE_TRANSITIONS: Record<SessionLifecycle, SessionLifecycle[]> = {
  initializing: ['active', 'waiting_human', 'paused', 'completed', 'error'],
  active: ['waiting_human', 'paused', 'completed', 'error'],
  waiting_human: ['active', 'paused', 'error'],
  paused: ['active', 'completed', 'error'],
  completed: ['active'],
  error: ['active', 'completed'],
};

const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  idle: ['thinking', 'tool_executing'],
  thinking: ['tool_executing', 'streaming_output', 'idle'],
  tool_executing: ['thinking', 'streaming_output', 'idle'],
  streaming_output: ['idle', 'thinking'],
};

export class StateMachine {
  private sessions = new Map<string, StateMachineState>();
  private transitionHistory = new Map<string, StateTransition[]>();
  private completedTimers = new Map<string, NodeJS.Timeout>();
  private completedTimerTokens = new Map<string, number>();
  private completedTimerSequence = 0;

  getState(sessionId: string): StateMachineState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const defaultState = this.createDefaultState();
    this.sessions.set(sessionId, defaultState);
    return defaultState;
  }

  getSnapshot(sessionId: string): SessionStateProjection {
    return toProjection(this.getState(sessionId));
  }

  getPanelProjection(sessionId: string): SessionPanelProjection {
    return toPanelProjection(this.getState(sessionId));
  }

  transition(
    sessionId: string,
    event: string,
    updates: TransitionUpdates,
    metadata: TransitionMetadata = {},
  ): { success: boolean; state: StateMachineState; error?: string } {
    const current = this.getState(sessionId);
    const timestamp = metadata.updatedAt ?? Date.now();

    const target: StateMachineState = {
      ...current,
      lifecycle: updates.lifecycle ?? current.lifecycle,
      execution: updates.execution !== undefined ? updates.execution : current.execution,
      gate: updates.gate !== undefined ? updates.gate : current.gate,
      displayState: metadata.displayState ?? current.displayState,
      stateSource: metadata.stateSource ?? current.stateSource,
      confidence: metadata.confidence ?? current.confidence,
      updatedAt: timestamp,
      turn: metadata.turn ?? current.turn,
      phase: metadata.phase ?? current.phase,
      humanResolved: metadata.humanResolved ?? current.humanResolved,
    };

    if (updates.lifecycle && updates.lifecycle !== current.lifecycle) {
      const allowed = LIFECYCLE_TRANSITIONS[current.lifecycle];
      if (!allowed.includes(updates.lifecycle)) {
        return {
          success: false,
          state: current,
          error: `非法生命周期转换: ${current.lifecycle} -> ${updates.lifecycle}`,
        };
      }
    }

    if (updates.execution !== undefined && updates.execution !== current.execution) {
      if (target.lifecycle !== 'active' && updates.execution !== null) {
        return {
          success: false,
          state: current,
          error: `执行状态仅在 lifecycle=active 时有效，当前 lifecycle=${target.lifecycle}`,
        };
      }

      if (current.execution && updates.execution) {
        const allowed = EXECUTION_TRANSITIONS[current.execution];
        if (!allowed.includes(updates.execution)) {
          return {
            success: false,
            state: current,
            error: `非法执行状态转换: ${current.execution} -> ${updates.execution}`,
          };
        }
      }
    }

    if (target.lifecycle !== 'active' && target.execution !== null) {
      target.execution = null;
    }

    if (this.isSameState(current, target)) {
      return { success: true, state: current };
    }

    this.sessions.set(sessionId, target);

    const transition: StateTransition = {
      from: { ...current },
      to: { ...target },
      event,
      timestamp,
      sessionId,
    };

    const history = this.transitionHistory.get(sessionId) || [];
    history.push(transition);
    if (history.length > 100) {
      history.shift();
    }
    this.transitionHistory.set(sessionId, history);

    console.log(
      `[state-machine] ${sessionId} | ${event} | lifecycle: ${current.lifecycle} -> ${target.lifecycle} | execution: ${current.execution} -> ${target.execution} | gate: ${current.gate} -> ${target.gate} | display: ${current.displayState} -> ${target.displayState}`,
    );

    return { success: true, state: target };
  }

  getTransitionHistory(sessionId: string): StateTransition[] {
    return this.transitionHistory.get(sessionId) || [];
  }

  resolveDisplayState(): UnifiedState {
    return resolveDisplayState(this.sessions.values());
  }

  shouldTransition(
    from: UnifiedState,
    to: UnifiedState,
    fromSource: 'formal' | 'inferred' = 'formal',
    toSource: 'formal' | 'inferred' = 'formal',
  ): boolean {
    const fromPri = STATE_PRIORITY[from] || 0;
    const toPri = STATE_PRIORITY[to] || 0;

    if (fromSource === 'formal' && toSource === 'inferred') {
      return toPri > fromPri;
    }

    return toPri >= fromPri;
  }

  getStateLabel(state: UnifiedState): string {
    return getStateLabel(state);
  }

  getStateColor(state: UnifiedState): number {
    return getStateColor(state);
  }

  setTurn(sessionId: string, turn: number, event = 'turn_set'): SessionStateProjection {
    const result = this.transition(sessionId, event, {}, { turn, humanResolved: false });
    return toProjection(result.state);
  }

  incrementTurn(sessionId: string): SessionStateProjection {
    const current = this.getState(sessionId);
    const result = this.transition(sessionId, 'turn_incremented', {}, {
      turn: current.turn + 1,
      humanResolved: false,
    });
    return toProjection(result.state);
  }

  advanceTurnToIdle(sessionId: string): SessionStateProjection {
    const current = this.getState(sessionId);
    const incremented = this.transition(sessionId, 'turn_incremented', {}, {
      turn: current.turn + 1,
      humanResolved: false,
    });
    const baseState = incremented.success ? incremented.state : current;
    const settled = this.transition(
      sessionId,
      'turn_completed',
      { lifecycle: 'active', execution: 'idle', gate: null },
      {
        displayState: 'idle',
        stateSource: 'formal',
        confidence: 'high',
        phase: getStateLabel('idle'),
        humanResolved: false,
        turn: baseState.turn,
      },
    );
    return toProjection(settled.success ? settled.state : baseState);
  }

  applyPlatformEvent(event: PlatformEvent): SessionStateProjection {
    const current = this.getState(event.sessionId);

    const mapped = mapEventToTransition(event, current, {
      shouldTransition: this.shouldTransition.bind(this),
      isSessionIdleTransitionAllowed: this.isSessionIdleTransitionAllowed.bind(this),
    });

    if (!mapped) return toProjection(current);

    const mappedState = PLATFORM_EVENT_TO_STATE[event.type]!;

    const shouldResetCompletedTimer =
      event.type === 'session_started' ||
      event.type === 'session_ended' ||
      (event.type !== 'completed' && mappedState !== 'completed' && current.displayState === 'completed');

    if (shouldResetCompletedTimer) {
      this.clearCompletedTimer(event.sessionId);
    }

    const result = this.transition(
      event.sessionId,
      event.type,
      mapped.updates,
      mapped.metadata,
    );

    if (!result.success) {
      return toProjection(current);
    }

    if (mappedState === 'completed') {
      this.clearCompletedTimer(event.sessionId);
      const timerToken = ++this.completedTimerSequence;
      const completedTurn = result.state.turn;

      const timer = setTimeout(() => {
        this.applyPlatformEvent({
          type: 'session_idle',
          sessionId: event.sessionId,
          source: event.source,
          stateSource: 'formal',
          confidence: 'high',
          timestamp: Date.now(),
          metadata: {
            phase: '待命',
            idleTimerToken: timerToken,
            turn: completedTurn,
          },
        });
        this.clearCompletedTimer(event.sessionId);
      }, 3000);

      this.completedTimers.set(event.sessionId, timer);
      this.completedTimerTokens.set(event.sessionId, timerToken);
    }

    return toProjection(result.state);
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.transitionHistory.delete(sessionId);
    this.clearCompletedTimer(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  private createDefaultState(): StateMachineState {
    return {
      lifecycle: 'initializing',
      execution: null,
      gate: null,
      displayState: 'idle',
      stateSource: 'formal',
      confidence: 'high',
      updatedAt: Date.now(),
      turn: 0,
      phase: STATE_LABELS.idle,
      humanResolved: false,
    };
  }

  private isSameState(a: StateMachineState, b: StateMachineState): boolean {
    return (
      a.lifecycle === b.lifecycle &&
      a.execution === b.execution &&
      a.gate === b.gate &&
      a.displayState === b.displayState &&
      a.stateSource === b.stateSource &&
      a.confidence === b.confidence &&
      a.updatedAt === b.updatedAt &&
      a.turn === b.turn &&
      a.phase === b.phase &&
      a.humanResolved === b.humanResolved
    );
  }

  private clearCompletedTimer(sessionId: string): void {
    const completedTimer = this.completedTimers.get(sessionId);
    if (completedTimer) {
      clearTimeout(completedTimer);
      this.completedTimers.delete(sessionId);
    }
    this.completedTimerTokens.delete(sessionId);
  }

  private isSessionIdleTransitionAllowed(
    event: PlatformEvent,
    current: StateMachineState,
  ): boolean {
    if (current.displayState === 'completed') {
      return true;
    }

    const idleTimerToken = this.readNumericMetadata(event.metadata, 'idleTimerToken');
    if (idleTimerToken === undefined) {
      return false;
    }

    const activeTimerToken = this.completedTimerTokens.get(event.sessionId);
    if (activeTimerToken !== idleTimerToken) {
      return false;
    }

    const timerTurn = this.readNumericMetadata(event.metadata, 'turn');
    if (timerTurn !== undefined && timerTurn !== current.turn) {
      return false;
    }

    return true;
  }

  private readNumericMetadata(
    metadata: Record<string, unknown> | undefined,
    field: string,
  ): number | undefined {
    const value = metadata?.[field];
    return typeof value === 'number' ? value : undefined;
  }
}

export const stateMachine = new StateMachine();
