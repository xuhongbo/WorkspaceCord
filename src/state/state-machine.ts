// 统一状态机
// 实现设计文档第 5.4 节的三层状态模型

import type { UnifiedState, SessionStateSnapshot, PlatformEvent } from './types.ts';
import { STATE_PRIORITY, STATE_LABELS, STATE_COLORS, PLATFORM_EVENT_TO_STATE } from './types.ts';

// ─── 状态定义 ─────────────────────────────────────────────────────────────────

// 第一层：会话生命周期状态
export type SessionLifecycle =
  | 'initializing'  // 会话初始化中
  | 'active'        // 会话活跃
  | 'waiting_human' // 等待人工介入
  | 'paused'        // 会话暂停
  | 'completed'     // 会话完成
  | 'error';        // 会话错误

// 第二层：执行状态（仅 active 时有效）
export type ExecutionState =
  | 'idle'              // 空闲
  | 'thinking'          // 思考中
  | 'tool_executing'    // 工具执行中
  | 'streaming_output'; // 流式输出中

// 第三层：门控状态（独立管理）
export type GateStatus =
  | 'pending'      // 待处理
  | 'approved'     // 已批准
  | 'rejected'     // 已拒绝
  | 'expired'      // 已过期
  | 'invalidated'; // 已失效

// ─── 状态机核心 ───────────────────────────────────────────────────────────────

export interface StateMachineState {
  lifecycle: SessionLifecycle;
  execution: ExecutionState | null; // 仅 lifecycle=active 时有效
  gate: GateStatus | null;          // 仅存在门控时有效
}

export interface StateTransition {
  from: StateMachineState;
  to: StateMachineState;
  event: string;
  timestamp: number;
  sessionId: string;
}

// 状态转换规则
const LIFECYCLE_TRANSITIONS: Record<SessionLifecycle, SessionLifecycle[]> = {
  initializing: ['active', 'error'],
  active: ['waiting_human', 'paused', 'completed', 'error'],
  waiting_human: ['active', 'paused', 'error'],
  paused: ['active', 'completed', 'error'],
  completed: ['active'], // 允许重新激活
  error: ['active', 'completed'], // 允许恢复或标记完成
};

const EXECUTION_TRANSITIONS: Record<ExecutionState, ExecutionState[]> = {
  idle: ['thinking', 'tool_executing'], // idle 不能直接跳到 streaming_output
  thinking: ['tool_executing', 'streaming_output', 'idle'],
  tool_executing: ['thinking', 'streaming_output', 'idle'],
  streaming_output: ['idle', 'thinking'],
};

// ─── 状态机类 ─────────────────────────────────────────────────────────────────

export class StateMachine {
  private sessions = new Map<string, StateMachineState>();
  private legacySessions = new Map<string, SessionStateSnapshot>();
  private transitionHistory = new Map<string, StateTransition[]>();
  private completedTimers = new Map<string, NodeJS.Timeout>();
  private completedTimerTokens = new Map<string, number>();
  private completedTimerSequence = 0;

  /**
   * 获取会话状态，如果不存在则创建默认状态
   */
  getState(sessionId: string): StateMachineState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const defaultState = this.createDefaultState();
    this.sessions.set(sessionId, defaultState);
    return defaultState;
  }

  /**
   * 状态转换（单一入口）
   * 验证转换合法性，记录转换历史，确保幂等性
   */
  transition(
    sessionId: string,
    event: string,
    updates: {
      lifecycle?: SessionLifecycle;
      execution?: ExecutionState | null;
      gate?: GateStatus | null;
    }
  ): { success: boolean; state: StateMachineState; error?: string } {
    const current = this.getState(sessionId);
    const timestamp = Date.now();

    // 构建目标状态
    const target: StateMachineState = {
      lifecycle: updates.lifecycle ?? current.lifecycle,
      execution: updates.execution !== undefined ? updates.execution : current.execution,
      gate: updates.gate !== undefined ? updates.gate : current.gate,
    };

    // 幂等性检查：如果状态完全相同，直接返回成功
    if (
      target.lifecycle === current.lifecycle &&
      target.execution === current.execution &&
      target.gate === current.gate
    ) {
      return { success: true, state: current };
    }

    // 验证生命周期转换
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

    // 验证执行状态转换
    if (updates.execution !== undefined && updates.execution !== current.execution) {
      // 执行状态仅在 lifecycle=active 时有效
      if (target.lifecycle !== 'active' && updates.execution !== null) {
        return {
          success: false,
          state: current,
          error: `执行状态仅在 lifecycle=active 时有效，当前 lifecycle=${target.lifecycle}`,
        };
      }

      // 验证执行状态转换规则
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

    // 自动清理执行状态（当 lifecycle 不是 active 时）
    if (target.lifecycle !== 'active' && target.execution !== null) {
      target.execution = null;
    }

    // 应用状态转换
    this.sessions.set(sessionId, target);

    // 记录转换历史
    const transition: StateTransition = {
      from: current,
      to: target,
      event,
      timestamp,
      sessionId,
    };

    const history = this.transitionHistory.get(sessionId) || [];
    history.push(transition);
    // 保留最近 100 条转换记录
    if (history.length > 100) {
      history.shift();
    }
    this.transitionHistory.set(sessionId, history);

    // 记录日志
    console.log(
      `[state-machine] ${sessionId} | ${event} | lifecycle: ${current.lifecycle} -> ${target.lifecycle} | execution: ${current.execution} -> ${target.execution} | gate: ${current.gate} -> ${target.gate}`
    );

    return { success: true, state: target };
  }

  /**
   * 获取转换历史
   */
  getTransitionHistory(sessionId: string): StateTransition[] {
    return this.transitionHistory.get(sessionId) || [];
  }

  // ─── 兼容旧版 SessionStateSnapshot 接口 ───────────────────────────────────────

  ensureSession(sessionId: string): SessionStateSnapshot {
    const existing = this.legacySessions.get(sessionId);
    if (existing) return existing;

    const created = this.createDefaultSnapshot();
    this.legacySessions.set(sessionId, created);
    return created;
  }

  updateSession(sessionId: string, patch: Partial<SessionStateSnapshot>): void {
    const current = this.ensureSession(sessionId);
    this.legacySessions.set(sessionId, {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    });
  }

  getSession(sessionId: string): SessionStateSnapshot | undefined {
    return this.legacySessions.get(sessionId);
  }

  resolveDisplayState(): UnifiedState {
    let best: UnifiedState = 'idle';
    let bestPri = 0;

    for (const snapshot of this.legacySessions.values()) {
      const pri = STATE_PRIORITY[snapshot.state] || 0;
      if (pri > bestPri) {
        best = snapshot.state;
        bestPri = pri;
      }
    }

    return best;
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
    return STATE_LABELS[state] || state;
  }

  getStateColor(state: UnifiedState): number {
    return STATE_COLORS[state] || 0x808080;
  }

  incrementTurn(sessionId: string): SessionStateSnapshot {
    const current = this.ensureSession(sessionId);
    const nextTurn = current.turn + 1;
    this.updateSession(sessionId, {
      turn: nextTurn,
      isCompleted: false,
      isWaitingHuman: false,
      humanResolved: false,
    });
    return this.ensureSession(sessionId);
  }

  applyPlatformEvent(event: PlatformEvent): SessionStateSnapshot {
    const mappedState = PLATFORM_EVENT_TO_STATE[event.type];
    const current = this.ensureSession(event.sessionId);

    if (!mappedState) return current;

    if (event.type === 'session_idle' && !this.isSessionIdleTransitionAllowed(event, current)) {
      return current;
    }

    const allowTransition =
      event.type === 'human_resolved' ||
      event.type === 'completed' ||
      event.type === 'session_ended' ||
      this.shouldTransition(
        current.state,
        mappedState,
        current.stateSource,
        event.stateSource ?? 'formal',
      );

    if (!allowTransition) {
      return current;
    }

    const phaseLabel = (event.metadata?.phase as string) ?? this.getStateLabel(mappedState);

    const patch: Partial<SessionStateSnapshot> = {
      state: mappedState,
      stateSource: event.stateSource ?? 'formal',
      confidence: event.confidence,
      phase: phaseLabel,
      isWaitingHuman: mappedState === 'awaiting_human',
      humanResolved: event.type === 'human_resolved',
      isCompleted: mappedState === 'completed',
      isError: mappedState === 'error',
      isStalled: mappedState === 'stalled',
    };

    if (event.type === 'session_started' && current.turn <= 0) {
      patch.turn = 1;
    }

    if (event.type === 'session_ended') {
      patch.isWaitingHuman = false;
    }

    const shouldResetCompletedTimer =
      event.type === 'session_started' ||
      event.type === 'session_ended' ||
      (event.type !== 'completed' && mappedState !== 'completed' && current.state === 'completed');

    if (shouldResetCompletedTimer) {
      this.clearCompletedTimer(event.sessionId);
    }

    if (mappedState === 'completed') {
      this.clearCompletedTimer(event.sessionId);
      const timerToken = ++this.completedTimerSequence;
      const turn = current.turn;

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
            turn,
          },
        });
        this.clearCompletedTimer(event.sessionId);
      }, 3000);

      this.completedTimers.set(event.sessionId, timer);
      this.completedTimerTokens.set(event.sessionId, timerToken);
    }

    this.updateSession(event.sessionId, patch);
    return this.ensureSession(event.sessionId);
  }

  /**
   * 清理会话状态（用于会话结束）
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.legacySessions.delete(sessionId);
    this.transitionHistory.delete(sessionId);
    this.clearCompletedTimer(sessionId);
  }

  private createDefaultState(): StateMachineState {
    return {
      lifecycle: 'initializing',
      execution: null,
      gate: null,
    };
  }

  private createDefaultSnapshot(): SessionStateSnapshot {
    return {
      state: 'idle',
      stateSource: 'formal',
      confidence: 'high',
      updatedAt: Date.now(),
      turn: 0,
      isWaitingHuman: false,
      humanResolved: false,
      isCompleted: false,
      isError: false,
      isStalled: false,
    };
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
    current: SessionStateSnapshot,
  ): boolean {
    if (current.state === 'completed') {
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

// 导出单例
export const stateMachine = new StateMachine();
