// 平台事件到状态转换的映射逻辑
// 从 PlatformEvent 推导出 TransitionUpdates + TransitionMetadata

import type { UnifiedState, PlatformEvent } from './types.ts';
import { PLATFORM_EVENT_TO_STATE } from './types.ts';
import type { StateMachineState, SessionLifecycle, ExecutionState, GateStatus } from './state-machine.ts';
import { getStateLabel } from './state-projections.ts';

export type TransitionUpdates = {
  lifecycle?: SessionLifecycle;
  execution?: ExecutionState | null;
  gate?: GateStatus | null;
};

export type TransitionMetadata = {
  displayState?: UnifiedState;
  stateSource?: 'formal' | 'inferred';
  confidence?: 'high' | 'medium' | 'low';
  updatedAt?: number;
  turn?: number;
  phase?: string;
  humanResolved?: boolean;
};

export interface EventTransitionResult {
  updates: TransitionUpdates;
  metadata: TransitionMetadata;
}

/**
 * Maps a PlatformEvent to the transition updates and metadata needed by StateMachine.transition().
 * Returns null if the event should not cause a transition.
 */
export function mapEventToTransition(
  event: PlatformEvent,
  currentState: StateMachineState,
  context: {
    shouldTransition: (
      from: UnifiedState,
      to: UnifiedState,
      fromSource: 'formal' | 'inferred',
      toSource: 'formal' | 'inferred',
    ) => boolean;
    isSessionIdleTransitionAllowed: (event: PlatformEvent, current: StateMachineState) => boolean;
  },
): EventTransitionResult | null {
  const mappedState = PLATFORM_EVENT_TO_STATE[event.type];

  if (!mappedState) return null;

  if (event.type === 'session_idle' && !context.isSessionIdleTransitionAllowed(event, currentState)) {
    return null;
  }

  const allowTransition =
    event.type === 'human_resolved' ||
    event.type === 'completed' ||
    event.type === 'session_ended' ||
    context.shouldTransition(
      currentState.displayState,
      mappedState,
      currentState.stateSource,
      event.stateSource ?? 'formal',
    );

  if (!allowTransition) {
    return null;
  }

  const lifecycle = mapLifecycle(event, currentState, mappedState);
  const execution = mapExecution(event, currentState, mappedState, lifecycle);
  const gate = mapGate(event, currentState);
  const turn = resolveTurn(event, currentState);
  const humanResolved = resolveHumanResolved(event, currentState);
  const phaseLabel = (event.metadata?.phase as string) ?? getStateLabel(mappedState);

  return {
    updates: {
      lifecycle,
      execution,
      gate,
    },
    metadata: {
      displayState: mappedState,
      stateSource: event.stateSource ?? 'formal',
      confidence: event.confidence,
      updatedAt: event.timestamp,
      turn,
      phase: phaseLabel,
      humanResolved,
    },
  };
}

// ─── Internal mapping helpers ────────────────────────────────────────────────

function mapLifecycle(
  event: PlatformEvent,
  current: StateMachineState,
  mappedState: UnifiedState,
): SessionLifecycle {
  switch (event.type) {
    case 'session_started':
    case 'session_idle':
    case 'thinking_started':
    case 'work_started':
    case 'human_resolved':
    case 'compaction_started':
      return 'active';
    case 'awaiting_human':
      return 'waiting_human';
    case 'completed':
      return 'completed';
    case 'errored':
      return 'error';
    case 'stalled':
      return current.lifecycle === 'active' ? 'paused' : current.lifecycle;
    case 'session_ended':
      return current.lifecycle === 'initializing' ? 'initializing' : 'paused';
    default:
      return mapLifecycleFromState(mappedState, current.lifecycle);
  }
}

function mapLifecycleFromState(
  mappedState: UnifiedState,
  fallback: SessionLifecycle,
): SessionLifecycle {
  switch (mappedState) {
    case 'idle':
    case 'thinking':
    case 'working':
    case 'summarizing':
      return 'active';
    case 'awaiting_human':
      return 'waiting_human';
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'stalled':
      return 'paused';
    case 'offline':
      return fallback === 'initializing' ? 'initializing' : 'paused';
    default:
      return fallback;
  }
}

function mapExecution(
  event: PlatformEvent,
  current: StateMachineState,
  mappedState: UnifiedState,
  lifecycle: SessionLifecycle,
): ExecutionState | null {
  if (lifecycle !== 'active') return null;

  switch (event.type) {
    case 'session_started':
    case 'session_idle':
      return 'idle';
    case 'thinking_started':
      return 'thinking';
    case 'work_started':
      return 'tool_executing';
    case 'human_resolved':
      return 'tool_executing';
    case 'compaction_started':
      return 'thinking';
    default:
      return mapExecutionFromState(mappedState, current.execution);
  }
}

function mapExecutionFromState(
  mappedState: UnifiedState,
  fallback: ExecutionState | null,
): ExecutionState | null {
  switch (mappedState) {
    case 'idle':
      return 'idle';
    case 'thinking':
    case 'summarizing':
      return 'thinking';
    case 'working':
      return 'tool_executing';
    default:
      return fallback;
  }
}

function mapGate(event: PlatformEvent, current: StateMachineState): GateStatus | null {
  switch (event.type) {
    case 'awaiting_human':
      return 'pending';
    case 'human_resolved':
      return event.metadata?.action === 'reject' ? 'rejected' : 'approved';
    case 'session_idle':
      if (event.metadata?.action === 'reject' && current.gate === 'pending') {
        return 'rejected';
      }
      return current.gate;
    case 'session_ended':
      return current.gate === 'pending' ? 'invalidated' : current.gate;
    default:
      return current.gate;
  }
}

function resolveTurn(event: PlatformEvent, current: StateMachineState): number {
  if (event.type === 'session_started' && current.turn <= 0) {
    return 1;
  }
  return current.turn;
}

function resolveHumanResolved(
  event: PlatformEvent,
  current: StateMachineState,
): boolean {
  if (event.type === 'awaiting_human') return false;
  if (event.type === 'human_resolved') return true;
  if (event.type === 'session_idle' && event.metadata?.action === 'reject') return true;
  return current.humanResolved;
}
