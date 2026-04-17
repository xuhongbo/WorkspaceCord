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
  TodoItem,
  PendingApproval,
  SessionContextFields,
} from './types.ts';
import { STATE_LABELS } from './types.ts';

const MAX_RECENT_DENIALS = 5;
const MAX_PENDING_APPROVALS = 100;

export interface SessionMachineContext extends SessionContextFields {
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
interface BaseContextUpdates extends SessionContextFields {
  gate?: GateStatus | null;
  displayState?: UnifiedState;
  stateSource?: 'formal' | 'inferred';
  confidence?: 'high' | 'medium' | 'low';
  turn?: number;
  phase?: string;
  humanResolved?: boolean;
}

export type SessionMachineEvent =
  | ({
      type: 'SET_LIFECYCLE';
      lifecycle: SessionLifecycle;
      execution?: ExecutionState | null;
      updatedAt: number;
    } & BaseContextUpdates)
  | ({
      type: 'SET_EXECUTION';
      execution: ExecutionState | null;
      updatedAt: number;
    } & BaseContextUpdates)
  | ({
      type: 'UPDATE_CONTEXT';
      updatedAt: number;
    } & BaseContextUpdates)
  | {
      type: 'TODO_UPDATED';
      items: TodoItem[];
      updatedAt: number;
    }
  | {
      type: 'PERMISSION_DENIED';
      toolName: string;
      reason: string;
      updatedAt: number;
    }
  | {
      type: 'BATCH_APPROVAL_SET';
      enabled: boolean;
      pendingApprovals?: PendingApproval[];
      updatedAt: number;
    }
  | {
      type: 'BATCH_APPROVAL_ENQUEUE';
      approval: PendingApproval;
      updatedAt: number;
    }
  | {
      type: 'BATCH_APPROVAL_CLEAR';
      updatedAt: number;
    }
  | {
      type: 'BATCH_APPROVAL_REMOVE';
      gateId: string;
      updatedAt: number;
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
      if ('todoList' in event && event.todoList !== undefined) {
        updates.todoList = event.todoList;
        updates.todoUpdatedAt = event.updatedAt;
      }
      if ('todoUpdatedAt' in event && event.todoUpdatedAt !== undefined) {
        updates.todoUpdatedAt = event.todoUpdatedAt;
      }
      if ('recentPermissionDenials' in event && event.recentPermissionDenials !== undefined) {
        updates.recentPermissionDenials = event.recentPermissionDenials;
      }
      if ('batchApprovalMode' in event && event.batchApprovalMode !== undefined) {
        updates.batchApprovalMode = event.batchApprovalMode;
      }
      if ('pendingApprovals' in event && event.pendingApprovals !== undefined) {
        updates.pendingApprovals = event.pendingApprovals;
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
    applyTodoList: assign(({ context, event }) => {
      if (event.type !== 'TODO_UPDATED') return context;
      return {
        ...context,
        todoList: event.items,
        todoUpdatedAt: event.updatedAt,
        updatedAt: event.updatedAt,
      };
    }),
    pushPermissionDenial: assign(({ context, event }) => {
      if (event.type !== 'PERMISSION_DENIED') return context;
      const previous = context.recentPermissionDenials ?? [];
      const next = [
        { toolName: event.toolName, reason: event.reason, timestamp: event.updatedAt },
        ...previous,
      ].slice(0, MAX_RECENT_DENIALS);
      return {
        ...context,
        recentPermissionDenials: next,
        updatedAt: event.updatedAt,
      };
    }),
    applyBatchApprovalSet: assign(({ context, event }) => {
      if (event.type !== 'BATCH_APPROVAL_SET') return context;
      // Always copy so downstream reference-equality checks (panel-adapter's
      // contextChanged) see a fresh array when the queue is re-seeded.
      const pending = event.enabled
        ? [...(event.pendingApprovals ?? context.pendingApprovals ?? [])]
        : [];
      return {
        ...context,
        batchApprovalMode: event.enabled,
        pendingApprovals: pending,
        updatedAt: event.updatedAt,
      };
    }),
    enqueuePendingApproval: assign(({ context, event }) => {
      if (event.type !== 'BATCH_APPROVAL_ENQUEUE') return context;
      const previous = context.pendingApprovals ?? [];
      return {
        ...context,
        pendingApprovals: [...previous, event.approval].slice(-MAX_PENDING_APPROVALS),
        updatedAt: event.updatedAt,
      };
    }),
    clearPendingApprovals: assign(({ context, event }) => {
      if (event.type !== 'BATCH_APPROVAL_CLEAR') return context;
      return {
        ...context,
        pendingApprovals: [],
        updatedAt: event.updatedAt,
      };
    }),
    removePendingApproval: assign(({ context, event }) => {
      if (event.type !== 'BATCH_APPROVAL_REMOVE') return context;
      const previous = context.pendingApprovals ?? [];
      const next = previous.filter((e) => e.gateId !== event.gateId);
      if (next.length === previous.length) return context;
      return {
        ...context,
        pendingApprovals: next,
        updatedAt: event.updatedAt,
      };
    }),
  },
}).createMachine({
  id: 'session',
  type: 'parallel',
  // 顶层事件:TODO_UPDATED / PERMISSION_DENIED / BATCH_APPROVAL_* 只更新 context,
  // 不改变 lifecycle 或 execution 子状态,因此放在顶层而不是某个子节点。
  on: {
    TODO_UPDATED: { actions: 'applyTodoList' },
    PERMISSION_DENIED: { actions: 'pushPermissionDenial' },
    BATCH_APPROVAL_SET: { actions: 'applyBatchApprovalSet' },
    BATCH_APPROVAL_ENQUEUE: { actions: 'enqueuePendingApproval' },
    BATCH_APPROVAL_CLEAR: { actions: 'clearPendingApprovals' },
    BATCH_APPROVAL_REMOVE: { actions: 'removePendingApproval' },
  },
  context: {
    gate: null,
    displayState: 'idle',
    stateSource: 'formal',
    confidence: 'high',
    updatedAt: 0,
    turn: 0,
    phase: STATE_LABELS.idle,
    humanResolved: false,
    todoList: undefined,
    todoUpdatedAt: undefined,
    recentPermissionDenials: undefined,
    batchApprovalMode: false,
    pendingApprovals: undefined,
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
