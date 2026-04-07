// 状态投影与显示辅助函数
// 纯函数，不依赖类状态

import type { UnifiedState, SessionStateProjection, SessionPanelProjection } from './types.ts';
import { STATE_PRIORITY, STATE_LABELS, STATE_COLORS } from './types.ts';
import type { StateMachineState } from './state-machine.ts';

export function toProjection(state: StateMachineState): SessionStateProjection {
  return {
    state: state.displayState,
    stateSource: state.stateSource,
    confidence: state.confidence,
    updatedAt: state.updatedAt,
    turn: state.turn,
    phase: state.phase,
    humanResolved: state.humanResolved,
  };
}

export function toPanelProjection(state: StateMachineState): SessionPanelProjection {
  return {
    ...toProjection(state),
    isWaitingHuman:
      state.lifecycle === 'waiting_human' ||
      state.gate === 'pending' ||
      state.displayState === 'awaiting_human',
    isCompleted: state.displayState === 'completed' || state.lifecycle === 'completed',
    isError: state.displayState === 'error' || state.lifecycle === 'error',
    isStalled: state.displayState === 'stalled',
  };
}

export function resolveDisplayState(
  sessions: Iterable<StateMachineState>,
): UnifiedState {
  let best: UnifiedState = 'idle';
  let bestPri = 0;

  for (const state of sessions) {
    const pri = STATE_PRIORITY[state.displayState] || 0;
    if (pri > bestPri) {
      best = state.displayState;
      bestPri = pri;
    }
  }

  return best;
}

export function getStateLabel(state: UnifiedState): string {
  return STATE_LABELS[state] || state;
}

export function getStateColor(state: UnifiedState): number {
  return STATE_COLORS[state] || 0x808080;
}
