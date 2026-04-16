// Domain event catalog — P3a 的类型安全事件契约
// 所有跨包通信应尽量通过这里定义的 EventType<T> 发布/订阅,避免直接函数调用耦合。
//
// 生产者与订阅者:
//   - engine:  session.turn_started / turn_completed / errored / ended / result
//   - state:   gate.created / gate.resolved / session.state_changed
//   - bot:     订阅上述事件渲染面板;发 discord.ready
//
// 约定:payload 类型严格 readonly,禁止订阅者改写事件对象。

import { EventBus } from './event-bus.ts';
import type { EventType } from './events.ts';

// ─── Session 相关事件 ────────────────────────────────────────────────────────

export interface SessionTurnStartedPayload {
  readonly sessionId: string;
  readonly turn: number;
  readonly mode: string;
  readonly provider: 'claude' | 'codex';
}

export interface SessionTurnCompletedPayload {
  readonly sessionId: string;
  readonly turn: number;
  readonly success: boolean;
  readonly costUsd: number;
  readonly durationMs: number;
}

export interface SessionErroredPayload {
  readonly sessionId: string;
  readonly errorMessage: string;
  readonly phase: 'worker' | 'monitor' | 'stream';
}

export interface SessionAwaitingHumanPayload {
  readonly sessionId: string;
  readonly detail: string;
  readonly turn: number;
}

export interface SessionResumedPayload {
  readonly sessionId: string;
  readonly reason: 'gate_resolved' | 'user_continue' | 'monitor_step';
}

// ─── 域事件名称(EventType branded strings)───────────────────────────────────

export const SessionTurnStarted = 'session.turn.started' as EventType<SessionTurnStartedPayload>;
export const SessionTurnCompleted = 'session.turn.completed' as EventType<SessionTurnCompletedPayload>;
export const SessionErrored = 'session.errored' as EventType<SessionErroredPayload>;
export const SessionAwaitingHuman = 'session.awaiting_human' as EventType<SessionAwaitingHumanPayload>;
export const SessionResumed = 'session.resumed' as EventType<SessionResumedPayload>;

// ─── 门控事件(与 GateService 现有 emit 契约对齐)──────────────────────────

export interface GateCreatedEventPayload {
  readonly gateId: string;
  readonly sessionId: string;
  readonly provider: 'claude' | 'codex';
  readonly isBlocking: boolean;
}

export interface GateResolvedEventPayload {
  readonly gateId: string;
  readonly status: 'approved' | 'rejected';
  readonly resolvedBy: 'discord' | 'terminal' | 'timeout' | 'restart';
  readonly resolvedAction?: 'approve' | 'reject';
}

export const GateCreated = 'gate.created' as EventType<GateCreatedEventPayload>;
export const GateResolved = 'gate.resolved' as EventType<GateResolvedEventPayload>;

// ─── 默认 bus 单例 ──────────────────────────────────────────────────────────

let _domainBus: EventBus | null = null;

/** 获取进程内唯一的 domain event bus。 */
export function getDomainBus(): EventBus {
  if (!_domainBus) _domainBus = new EventBus();
  return _domainBus;
}

/** 测试工具:替换 bus 实例,用于隔离。 */
export function _setDomainBusForTest(bus: EventBus | null): void {
  _domainBus = bus;
}
