// XState 会话状态机定义
// P2 重构:把原 state-machine.ts 的转移表 + 3s auto-idle 定时器搬到 XState v5 声明式定义。
// 每个 session 对应一个 `createActor(sessionMachine)` 实例,由外层 StateMachine 类管理生命周期。
//
// 设计要点:
//   - parallel 顶层:lifecycle 子树 + execution 子树并行运行
//   - context 保存所有额外投影字段(turn / humanResolved / phase / displayState / stateSource / confidence / updatedAt / gate)
//   - 'completed' 状态用 `after.3000 → idle` 取代旧的手写 completedTimers + token-race 逻辑
//   - 非法转移由 XState 内部忽略;外层 wrapper 根据 snapshot 前后是否变化来判定 success
//
// 复杂行为(turn metadata 的传递 / gate status / stateSource 级联判定)由 wrapper 在 send 前/后同步处理,
// 保持现有公共 API 与 829 tests 完全兼容。

import { assign, setup } from 'xstate';
import type {
  SessionLifecycle,
  ExecutionState,
  GateStatus,
  UnifiedState,
} from './types.ts';
import { STATE_LABELS } from './types.ts';

export interface SessionMachineContext {
  gate: GateStatus | null;
  displayState: UnifiedState;
  stateSource: 'formal' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  updatedAt: number;
  turn: number;
  phase?: string;
  humanResolved: boolean;
}

/**
 * 事件负载一律携带完整的 transition metadata,由 wrapper 层调用 send 前填好。
 * 这样机器内部只负责 state 切换,不做 metadata 推理。
 */
export type SessionMachineEvent =
  | {
      type: 'SET_LIFECYCLE';
      lifecycle: SessionLifecycle;
      gate?: GateStatus | null;
      execution?: ExecutionState | null;
      displayState?: UnifiedState;
      stateSource?: 'formal' | 'inferred';
      confidence?: 'high' | 'medium' | 'low';
      updatedAt: number;
      turn?: number;
      phase?: string;
      humanResolved?: boolean;
    }
  | {
      type: 'SET_EXECUTION';
      execution: ExecutionState | null;
      gate?: GateStatus | null;
      displayState?: UnifiedState;
      stateSource?: 'formal' | 'inferred';
      confidence?: 'high' | 'medium' | 'low';
      updatedAt: number;
      turn?: number;
      phase?: string;
      humanResolved?: boolean;
    }
  | {
      type: 'UPDATE_CONTEXT';
      gate?: GateStatus | null;
      displayState?: UnifiedState;
      stateSource?: 'formal' | 'inferred';
      confidence?: 'high' | 'medium' | 'low';
      updatedAt: number;
      turn?: number;
      phase?: string;
      humanResolved?: boolean;
    }
  | {
      type: 'AUTO_IDLE';
      updatedAt: number;
    };

// 生命周期转移表(与原 state-machine.ts 保持一致)
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

export function isLifecycleTransitionAllowed(
  from: SessionLifecycle,
  to: SessionLifecycle,
): boolean {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isExecutionTransitionAllowed(
  from: ExecutionState | null,
  to: ExecutionState | null,
): boolean {
  if (to === null || from === null) return true;
  return EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

const COMPLETED_AUTO_IDLE_DELAY_MS = 3_000;

// ─── 机器定义 ────────────────────────────────────────────────────────────────

export const sessionMachine = setup({
  types: {
    context: {} as SessionMachineContext,
    events: {} as SessionMachineEvent,
  },
  actions: {
    applyContextUpdates: assign(({ context, event }) => {
      const updates: Partial<SessionMachineContext> = {};
      if ('gate' in event && event.gate !== undefined) updates.gate = event.gate;
      if ('displayState' in event && event.displayState !== undefined) {
        updates.displayState = event.displayState;
      }
      if ('stateSource' in event && event.stateSource !== undefined) {
        updates.stateSource = event.stateSource;
      }
      if ('confidence' in event && event.confidence !== undefined) {
        updates.confidence = event.confidence;
      }
      if ('updatedAt' in event) updates.updatedAt = event.updatedAt;
      if ('turn' in event && event.turn !== undefined) updates.turn = event.turn;
      if ('phase' in event && event.phase !== undefined) updates.phase = event.phase;
      if ('humanResolved' in event && event.humanResolved !== undefined) {
        updates.humanResolved = event.humanResolved;
      }
      return { ...context, ...updates };
    }),
    markAutoIdle: assign(({ context, event }) => ({
      ...context,
      displayState: 'idle' as UnifiedState,
      phase: STATE_LABELS.idle,
      stateSource: 'formal' as const,
      confidence: 'high' as const,
      updatedAt: event.type === 'AUTO_IDLE' ? event.updatedAt : Date.now(),
    })),
  },
}).createMachine({
  id: 'session',
  type: 'parallel',
  context: {
    gate: null,
    displayState: 'idle',
    stateSource: 'formal',
    confidence: 'high',
    updatedAt: 0,
    turn: 0,
    phase: STATE_LABELS.idle,
    humanResolved: false,
  },
  states: {
    lifecycle: {
      initial: 'initializing',
      states: {
        initializing: {
          on: {
            SET_LIFECYCLE: [
              { target: 'active', guard: ({ event }) => event.lifecycle === 'active', actions: 'applyContextUpdates' },
              { target: 'waiting_human', guard: ({ event }) => event.lifecycle === 'waiting_human', actions: 'applyContextUpdates' },
              { target: 'paused', guard: ({ event }) => event.lifecycle === 'paused', actions: 'applyContextUpdates' },
              { target: 'completed', guard: ({ event }) => event.lifecycle === 'completed', actions: 'applyContextUpdates' },
              { target: 'error', guard: ({ event }) => event.lifecycle === 'error', actions: 'applyContextUpdates' },
            ],
            UPDATE_CONTEXT: { actions: 'applyContextUpdates' },
          },
        },
        active: {
          on: {
            SET_LIFECYCLE: [
              { target: 'waiting_human', guard: ({ event }) => event.lifecycle === 'waiting_human', actions: 'applyContextUpdates' },
              { target: 'paused', guard: ({ event }) => event.lifecycle === 'paused', actions: 'applyContextUpdates' },
              { target: 'completed', guard: ({ event }) => event.lifecycle === 'completed', actions: 'applyContextUpdates' },
              { target: 'error', guard: ({ event }) => event.lifecycle === 'error', actions: 'applyContextUpdates' },
            ],
            UPDATE_CONTEXT: { actions: 'applyContextUpdates' },
          },
        },
        waiting_human: {
          on: {
            SET_LIFECYCLE: [
              { target: 'active', guard: ({ event }) => event.lifecycle === 'active', actions: 'applyContextUpdates' },
              { target: 'paused', guard: ({ event }) => event.lifecycle === 'paused', actions: 'applyContextUpdates' },
              { target: 'error', guard: ({ event }) => event.lifecycle === 'error', actions: 'applyContextUpdates' },
            ],
            UPDATE_CONTEXT: { actions: 'applyContextUpdates' },
          },
        },
        paused: {
          on: {
            SET_LIFECYCLE: [
              { target: 'active', guard: ({ event }) => event.lifecycle === 'active', actions: 'applyContextUpdates' },
              { target: 'completed', guard: ({ event }) => event.lifecycle === 'completed', actions: 'applyContextUpdates' },
              { target: 'error', guard: ({ event }) => event.lifecycle === 'error', actions: 'applyContextUpdates' },
            ],
            UPDATE_CONTEXT: { actions: 'applyContextUpdates' },
          },
        },
        completed: {
          after: {
            [COMPLETED_AUTO_IDLE_DELAY_MS]: {
              // XState 自带定时器取代旧 completedTimers / token 方案。
              // 进入 completed 分支时设定,若 3s 内离开(新事件),自动取消。
              actions: 'markAutoIdle',
              target: '#session.lifecycle.active',
            },
          },
          on: {
            SET_LIFECYCLE: [
              { target: 'active', guard: ({ event }) => event.lifecycle === 'active', actions: 'applyContextUpdates' },
            ],
            UPDATE_CONTEXT: { actions: 'applyContextUpdates' },
          },
        },
        error: {
          on: {
            SET_LIFECYCLE: [
              { target: 'active', guard: ({ event }) => event.lifecycle === 'active', actions: 'applyContextUpdates' },
              { target: 'completed', guard: ({ event }) => event.lifecycle === 'completed', actions: 'applyContextUpdates' },
            ],
            UPDATE_CONTEXT: { actions: 'applyContextUpdates' },
          },
        },
      },
    },
    execution: {
      initial: 'none',
      states: {
        // 非 active 时执行态必须为 null,用 'none' 节点表达
        none: {
          on: {
            SET_EXECUTION: [
              { target: 'idle', guard: ({ event }) => event.execution === 'idle', actions: 'applyContextUpdates' },
              { target: 'thinking', guard: ({ event }) => event.execution === 'thinking', actions: 'applyContextUpdates' },
              { target: 'tool_executing', guard: ({ event }) => event.execution === 'tool_executing', actions: 'applyContextUpdates' },
              { target: 'streaming_output', guard: ({ event }) => event.execution === 'streaming_output', actions: 'applyContextUpdates' },
            ],
          },
        },
        idle: {
          on: {
            SET_EXECUTION: [
              { target: 'thinking', guard: ({ event }) => event.execution === 'thinking', actions: 'applyContextUpdates' },
              { target: 'tool_executing', guard: ({ event }) => event.execution === 'tool_executing', actions: 'applyContextUpdates' },
              { target: 'none', guard: ({ event }) => event.execution === null, actions: 'applyContextUpdates' },
            ],
          },
        },
        thinking: {
          on: {
            SET_EXECUTION: [
              { target: 'tool_executing', guard: ({ event }) => event.execution === 'tool_executing', actions: 'applyContextUpdates' },
              { target: 'streaming_output', guard: ({ event }) => event.execution === 'streaming_output', actions: 'applyContextUpdates' },
              { target: 'idle', guard: ({ event }) => event.execution === 'idle', actions: 'applyContextUpdates' },
              { target: 'none', guard: ({ event }) => event.execution === null, actions: 'applyContextUpdates' },
            ],
          },
        },
        tool_executing: {
          on: {
            SET_EXECUTION: [
              { target: 'thinking', guard: ({ event }) => event.execution === 'thinking', actions: 'applyContextUpdates' },
              { target: 'streaming_output', guard: ({ event }) => event.execution === 'streaming_output', actions: 'applyContextUpdates' },
              { target: 'idle', guard: ({ event }) => event.execution === 'idle', actions: 'applyContextUpdates' },
              { target: 'none', guard: ({ event }) => event.execution === null, actions: 'applyContextUpdates' },
            ],
          },
        },
        streaming_output: {
          on: {
            SET_EXECUTION: [
              { target: 'idle', guard: ({ event }) => event.execution === 'idle', actions: 'applyContextUpdates' },
              { target: 'thinking', guard: ({ event }) => event.execution === 'thinking', actions: 'applyContextUpdates' },
              { target: 'none', guard: ({ event }) => event.execution === null, actions: 'applyContextUpdates' },
            ],
          },
        },
      },
    },
  },
});

export type SessionMachineSnapshot = ReturnType<typeof sessionMachine.getInitialSnapshot>;
