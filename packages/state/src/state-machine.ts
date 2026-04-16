// 统一状态机 — P2 重构后:XState 驱动的内部实现,保留原公共 API。
//
// 架构:
//   - 声明式 machine definition 在 ./xstate-session-machine.ts
//   - 每个 session 对应一个 XState actor(createActor 实例)
//   - StateMachine 类是 actor 注册表 + 事件适配器,把 PlatformEvent / 转移 API 翻译成 XState 事件
//   - 3s auto-idle 定时器由 XState 的 `after` 内置处理
//   - transition() 仍按原契约返回 { success, state, error? },由 wrapper 前后对比判定

import { createActor, type Actor } from 'xstate';
import type {
  UnifiedState,
  SessionStateProjection,
  SessionPanelProjection,
  PlatformEvent,
} from './types.ts';
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
import {
  sessionMachine,
  isLifecycleTransitionAllowed,
  isExecutionTransitionAllowed,
} from './xstate-session-machine.ts';

// Re-export types 保留
export type {
  SessionLifecycle,
  ExecutionState,
  GateStatus,
  StateMachineState,
  StateTransition,
  TransitionUpdates,
  TransitionMetadata,
} from './types.ts';

export { toProjection, toPanelProjection, resolveDisplayState, getStateLabel, getStateColor } from './state-projections.ts';
export { mapEventToTransition } from './state-event-mapper.ts';

// ─── StateMachine ────────────────────────────────────────────────────────────

interface SessionEntry {
  actor: Actor<typeof sessionMachine>;
  /** 缓存最新投影,供无 actor 时的默认值返回。 */
  snapshot: StateMachineState;
  unsubscribe: () => void;
}

/**
 * 持久化回调:StateMachine 在 turn / humanResolved 变化时调用,把 in-memory 权威值
 * 写到 ThreadSession(供崩溃恢复用)。由 bot 包在启动时注册。
 */
export type TurnStatePersister = (
  sessionId: string,
  projection: { turn: number; humanResolved: boolean },
) => void;

export class StateMachine {
  private sessions = new Map<string, SessionEntry>();
  private transitionHistory = new Map<string, StateTransition[]>();
  /** 用于过滤 XState 内部 AUTO_IDLE 触发的 session_idle 事件幂等 token(兼容旧行为)。 */
  private completedTimerTokens = new Map<string, number>();
  private completedTimerSequence = 0;
  private persister: TurnStatePersister | null = null;

  /**
   * 注册 turn/humanResolved 的持久化回调。在 bot 启动时绑定到 session-registry。
   * P2 后:此回调是唯一的写入路径,消除 ThreadSession 字段的多处直接修改。
   */
  registerTurnStatePersister(persister: TurnStatePersister | null): void {
    this.persister = persister;
  }

  getState(sessionId: string): StateMachineState {
    const entry = this.sessions.get(sessionId);
    if (entry) return entry.snapshot;
    const created = this.ensureSession(sessionId);
    return created.snapshot;
  }

  /**
   * 单独操作 humanResolved — P2 后唯一修改入口,取代散落的 `updateSession({ humanResolved })`。
   */
  setHumanResolved(sessionId: string, humanResolved: boolean): SessionStateProjection {
    const current = this.getState(sessionId);
    if (current.humanResolved === humanResolved) {
      return toProjection(current);
    }
    const result = this.transition(
      sessionId,
      humanResolved ? 'human_resolved_set' : 'human_resolved_cleared',
      {},
      { humanResolved },
    );
    return toProjection(result.state);
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
    const entry = this.ensureSession(sessionId);
    const current = entry.snapshot;
    const timestamp = metadata.updatedAt ?? Date.now();

    // 预期目标(用于 guard 检查 + 最终比较)
    const targetLifecycle: SessionLifecycle = updates.lifecycle ?? current.lifecycle;
    const targetExecution: ExecutionState | null =
      updates.execution !== undefined ? updates.execution : current.execution;
    const targetGate = updates.gate !== undefined ? updates.gate : current.gate;

    // 生命周期转移合法性
    if (updates.lifecycle && updates.lifecycle !== current.lifecycle) {
      if (!isLifecycleTransitionAllowed(current.lifecycle, updates.lifecycle)) {
        return {
          success: false,
          state: current,
          error: `非法生命周期转换: ${current.lifecycle} -> ${updates.lifecycle}`,
        };
      }
    }

    // 执行态必须在 lifecycle=active 下
    if (updates.execution !== undefined && updates.execution !== current.execution) {
      if (targetLifecycle !== 'active' && updates.execution !== null) {
        return {
          success: false,
          state: current,
          error: `执行状态仅在 lifecycle=active 时有效，当前 lifecycle=${targetLifecycle}`,
        };
      }
      if (!isExecutionTransitionAllowed(current.execution, updates.execution)) {
        return {
          success: false,
          state: current,
          error: `非法执行状态转换: ${current.execution} -> ${updates.execution}`,
        };
      }
    }

    // 构造新快照
    const target: StateMachineState = {
      ...current,
      lifecycle: targetLifecycle,
      execution: targetLifecycle !== 'active' ? null : targetExecution,
      gate: targetGate,
      displayState: metadata.displayState ?? current.displayState,
      stateSource: metadata.stateSource ?? current.stateSource,
      confidence: metadata.confidence ?? current.confidence,
      updatedAt: timestamp,
      turn: metadata.turn ?? current.turn,
      phase: metadata.phase ?? current.phase,
      humanResolved: metadata.humanResolved ?? current.humanResolved,
    };

    if (this.isSameState(current, target)) {
      return { success: true, state: current };
    }

    // 驱动 XState actor:先 SET_LIFECYCLE,再 SET_EXECUTION(如有变化),最后 UPDATE_CONTEXT 同步剩余字段
    if (target.lifecycle !== current.lifecycle) {
      entry.actor.send({
        type: 'SET_LIFECYCLE',
        lifecycle: target.lifecycle,
        gate: target.gate,
        execution: target.execution,
        displayState: target.displayState,
        stateSource: target.stateSource,
        confidence: target.confidence,
        updatedAt: timestamp,
        turn: target.turn,
        phase: target.phase,
        humanResolved: target.humanResolved,
      });
    }
    if (target.execution !== current.execution) {
      entry.actor.send({
        type: 'SET_EXECUTION',
        execution: target.execution,
        gate: target.gate,
        displayState: target.displayState,
        stateSource: target.stateSource,
        confidence: target.confidence,
        updatedAt: timestamp,
        turn: target.turn,
        phase: target.phase,
        humanResolved: target.humanResolved,
      });
    }
    // 即便 lifecycle / execution 没变,也要确保 gate / displayState / turn 等 context 同步
    entry.actor.send({
      type: 'UPDATE_CONTEXT',
      gate: target.gate,
      displayState: target.displayState,
      stateSource: target.stateSource,
      confidence: target.confidence,
      updatedAt: timestamp,
      turn: target.turn,
      phase: target.phase,
      humanResolved: target.humanResolved,
    });

    // 直接用 target 作为新 snapshot(XState 的 subscribe 也会更新 entry.snapshot,
    // 这里手动写入确保同步,避免测试中依赖微任务调度)
    entry.snapshot = target;

    // P2:turn/humanResolved 的唯一写入路径。若 session-registry 侧注册了持久化回调,
    // 在状态确实改变时同步写回,避免 ThreadSession 与 StateMachine 漂移。
    if (
      this.persister &&
      (current.turn !== target.turn || current.humanResolved !== target.humanResolved)
    ) {
      try {
        this.persister(sessionId, { turn: target.turn, humanResolved: target.humanResolved });
      } catch (err) {
        console.warn(
          `[state-machine] persister error for ${sessionId}: ${(err as Error).message}`,
        );
      }
    }

    this.recordTransition(sessionId, current, target, event, timestamp);

    console.log(
      `[state-machine] ${sessionId} | ${event} | lifecycle: ${current.lifecycle} -> ${target.lifecycle} | execution: ${current.execution} -> ${target.execution} | gate: ${current.gate} -> ${target.gate} | display: ${current.displayState} -> ${target.displayState}`,
    );

    return { success: true, state: target };
  }

  getTransitionHistory(sessionId: string): StateTransition[] {
    return this.transitionHistory.get(sessionId) || [];
  }

  resolveDisplayState(): UnifiedState {
    return resolveDisplayState(Array.from(this.sessions.values()).map((e) => e.snapshot));
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
      this.completedTimerTokens.delete(event.sessionId);
    }

    const result = this.transition(event.sessionId, event.type, mapped.updates, mapped.metadata);
    if (!result.success) return toProjection(current);

    // XState 的 after.3000 自动把 completed → idle 的 context 更新完成(markAutoIdle);
    // 这里我们仍然维护 token 用于旧的 idleTimerToken 兼容语义(外部 session_idle 事件重入)。
    if (mappedState === 'completed') {
      const timerToken = ++this.completedTimerSequence;
      this.completedTimerTokens.set(event.sessionId, timerToken);

      const entry = this.sessions.get(event.sessionId);
      const completedTurn = result.state.turn;
      if (entry) {
        // 旁路 setTimeout,确保测试可以通过 vi.advanceTimersByTime(3000) 触发
        // (XState 内部 after 也会触发 markAutoIdle,但 wrapper 要保证 applyPlatformEvent 入口被调用)
        setTimeout(() => {
          if (this.completedTimerTokens.get(event.sessionId) !== timerToken) return;
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
          this.completedTimerTokens.delete(event.sessionId);
        }, 3_000);
      }
    }

    return toProjection(result.state);
  }

  clearSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.unsubscribe();
      entry.actor.stop();
    }
    this.sessions.delete(sessionId);
    this.transitionHistory.delete(sessionId);
    this.completedTimerTokens.delete(sessionId);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private ensureSession(sessionId: string): SessionEntry {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const defaultState = this.createDefaultState();
    const actor = createActor(sessionMachine);
    actor.start();
    const unsubscribe = actor.subscribe((snap) => {
      // 同步 context 到缓存的 snapshot;lifecycle/execution 通过 value 读出
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      const value = snap.value as { lifecycle?: SessionLifecycle; execution?: string };
      const lifecycle = (value.lifecycle ?? entry.snapshot.lifecycle) as SessionLifecycle;
      const executionRaw = value.execution ?? 'none';
      const execution =
        executionRaw === 'none' ? null : (executionRaw as ExecutionState);
      entry.snapshot = {
        ...entry.snapshot,
        ...snap.context,
        lifecycle,
        execution,
      };
    });
    const entry: SessionEntry = { actor, snapshot: defaultState, unsubscribe: () => unsubscribe.unsubscribe() };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  private recordTransition(
    sessionId: string,
    from: StateMachineState,
    to: StateMachineState,
    event: string,
    timestamp: number,
  ): void {
    const transition: StateTransition = {
      from: { ...from },
      to: { ...to },
      event,
      timestamp,
      sessionId,
    };
    const history = this.transitionHistory.get(sessionId) || [];
    history.push(transition);
    if (history.length > 100) history.shift();
    this.transitionHistory.set(sessionId, history);
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

  private isSessionIdleTransitionAllowed(
    event: PlatformEvent,
    current: StateMachineState,
  ): boolean {
    if (current.displayState === 'completed') return true;

    const idleTimerToken = this.readNumericMetadata(event.metadata, 'idleTimerToken');
    if (idleTimerToken === undefined) return false;

    const activeTimerToken = this.completedTimerTokens.get(event.sessionId);
    if (activeTimerToken !== idleTimerToken) return false;

    const timerTurn = this.readNumericMetadata(event.metadata, 'turn');
    if (timerTurn !== undefined && timerTurn !== current.turn) return false;

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
