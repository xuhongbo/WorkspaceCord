// 统一状态类型定义
// 参考：clawd-on-desk/src/state.js

export type UnifiedState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'awaiting_human'
  | 'summarizing'
  | 'completed'
  | 'error'
  | 'stalled'
  | 'offline';

export type PlatformEventType =
  | 'session_started'
  | 'session_idle'
  | 'thinking_started'
  | 'work_started'
  | 'awaiting_human'
  | 'human_resolved'
  | 'compaction_started'
  | 'completed'
  | 'errored'
  | 'stalled'
  | 'session_ended'
  | 'todo_updated'
  | 'permission_denied'
  | 'batch_approval_changed';

export const STATE_PRIORITY: Record<UnifiedState, number> = {
  error: 9,
  awaiting_human: 8,
  stalled: 7,
  summarizing: 6,
  working: 5,
  thinking: 4,
  completed: 3,
  idle: 2,
  offline: 1,
};

export const STATE_LABELS: Record<UnifiedState, string> = {
  idle: '待命',
  thinking: '正在思考',
  working: '正在执行',
  awaiting_human: '等待人工处理',
  summarizing: '正在整理上下文',
  completed: '本轮已完成',
  error: '出现异常',
  stalled: '疑似卡住',
  offline: '已离线',
};

export const STATE_COLORS: Record<UnifiedState, number> = {
  idle: 0x808080, // 灰色
  thinking: 0x3498db, // 蓝色
  working: 0x2ecc71, // 绿色
  awaiting_human: 0xf39c12, // 橙色
  summarizing: 0x9b59b6, // 紫色
  completed: 0x27ae60, // 深绿
  error: 0xe74c3c, // 红色
  stalled: 0xe67e22, // 深橙
  offline: 0x95a5a6, // 浅灰
};

export interface TodoItem {
  text: string;
  completed: boolean;
}

export interface PendingApproval {
  gateId: string;
  toolName: string;
  detail: string;
  timestamp: number;
}

export interface PermissionDenialRecord {
  toolName: string;
  reason: string;
  timestamp: number;
}

/**
 * Shared context fields added on top of the core state machine fields.
 * Used by SessionStateProjection, StateMachineState, and TransitionMetadata
 * so the shape stays in sync across the three.
 */
export interface SessionContextFields {
  /** Latest TodoWrite / todo_list snapshot from the agent (both providers). */
  todoList?: TodoItem[];
  /** Timestamp of the last todoList update. */
  todoUpdatedAt?: number;
  /** Recent permission-denied events, newest first (max 5). */
  recentPermissionDenials?: PermissionDenialRecord[];
  /** Whether the session is in batch-approval (defer) mode. */
  batchApprovalMode?: boolean;
  /** Pending approvals queued while batch-approval mode is enabled. */
  pendingApprovals?: PendingApproval[];
}

export interface SessionStateProjection extends SessionContextFields {
  state: UnifiedState;
  stateSource: 'formal' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  updatedAt: number;
  turn: number;
  phase?: string;
  humanResolved: boolean;
}

export interface SessionPanelProjection extends SessionStateProjection {
  isWaitingHuman: boolean;
  isCompleted: boolean;
  isError: boolean;
  isStalled: boolean;
}

export interface PlatformEvent {
  type: PlatformEventType;
  sessionId: string;
  source: 'claude' | 'codex';
  stateSource?: 'formal' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export const PLATFORM_EVENT_TO_STATE: Partial<Record<PlatformEventType, UnifiedState>> = {
  session_started: 'idle',
  session_idle: 'idle',
  thinking_started: 'thinking',
  work_started: 'working',
  awaiting_human: 'awaiting_human',
  human_resolved: 'working',
  compaction_started: 'summarizing',
  completed: 'completed',
  errored: 'error',
  stalled: 'stalled',
  session_ended: 'offline',
};

export interface DigestItem {
  kind: string;
  text: string;
}

// ─── State machine types ─────────────────────────────────────────────────────

export type SessionLifecycle =
  | 'initializing'
  | 'active'
  | 'waiting_human'
  | 'paused'
  | 'completed'
  | 'error';

export type ExecutionState =
  | 'idle'
  | 'thinking'
  | 'tool_executing'
  | 'streaming_output';

export type GateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'invalidated';

export interface StateMachineState extends SessionContextFields {
  lifecycle: SessionLifecycle;
  execution: ExecutionState | null;
  gate: GateStatus | null;
  displayState: UnifiedState;
  stateSource: 'formal' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  updatedAt: number;
  turn: number;
  phase?: string;
  humanResolved: boolean;
}

export interface StateTransition {
  from: StateMachineState;
  to: StateMachineState;
  event: string;
  timestamp: number;
  sessionId: string;
}

export type TransitionUpdates = {
  lifecycle?: SessionLifecycle;
  execution?: ExecutionState | null;
  gate?: GateStatus | null;
};

export type TransitionMetadata = SessionContextFields & {
  displayState?: UnifiedState;
  stateSource?: 'formal' | 'inferred';
  confidence?: 'high' | 'medium' | 'low';
  updatedAt?: number;
  turn?: number;
  phase?: string;
  humanResolved?: boolean;
};
