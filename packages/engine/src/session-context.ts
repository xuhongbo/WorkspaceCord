// SessionContext — P5 的 "bundle" 替代全面 actor 模型
//
// 动机:代码库有 87+ 处 `getSession(sessionId)` + 多处从全局 Map 读 controller /
// projection 的模式,耦合在 session-registry 的单例上。全面 actor 化重构过大,
// 这里提供中间地带:
//   - SessionContext 把 session 相关的所有运行时句柄打包成一个对象
//   - SessionSupervisor 是唯一 owner,按 sessionId 维护 context 生命周期
//   - 新的调用路径优先接受 `ctx: SessionContext` 作为参数,从而天然避免散落的 Map 访问
//   - 旧的 `getSession(id)` 调用点保留,不强制一次性迁移
//
// 等全面改造完成后,底层单例可以在内部改名为 supervisor.getAll() 之类的迭代器,
// 而无需触及调用方。

import type { ThreadSession } from '@workspacecord/core';
import {
  getSession,
  getSessionController,
  debouncedSaveSession,
} from './session-registry.ts';
import { stateMachine } from '@workspacecord/state';
import type { SessionStateProjection } from '@workspacecord/state';

export interface SessionContext {
  readonly sessionId: string;
  /** 快照 session 对象;调用 `ctx.refresh()` 可以重新拿。 */
  session: ThreadSession;
  /** 该 session 当前的 AbortController(若在生成中)。 */
  controller: AbortController | undefined;
  /** 当前 state machine projection。 */
  projection: SessionStateProjection;
  /** 保存 session 字段变更。 */
  save: () => void;
  /** 重新从底层读出 session + projection + controller。 */
  refresh: () => void;
}

/**
 * 轻量 supervisor:按 id 持有 context。每个 session 在其生命周期内只有一个 context,
 * 被多个调用点共享;崩溃或 endSession 后由 supervisor 释放。
 */
class SessionSupervisor {
  private readonly contexts = new Map<string, SessionContext>();

  get(sessionId: string): SessionContext | undefined {
    const cached = this.contexts.get(sessionId);
    if (cached) {
      // 按需刷新底层引用(session 对象 identity 应当稳定,但 controller 会变化)
      this.syncContext(cached);
      return cached;
    }
    const session = getSession(sessionId);
    if (!session) return undefined;
    const ctx = this.build(session);
    this.contexts.set(sessionId, ctx);
    return ctx;
  }

  /** 枚举现有 context。用于 supervisor 层面的扫描(健康检查、空闲回收)。 */
  all(): SessionContext[] {
    return Array.from(this.contexts.values());
  }

  /** 释放某个 session 的 context(endSession 调用时触发)。 */
  release(sessionId: string): void {
    this.contexts.delete(sessionId);
  }

  releaseAll(): void {
    this.contexts.clear();
  }

  private build(session: ThreadSession): SessionContext {
    const ctx: SessionContext = {
      sessionId: session.id,
      session,
      controller: getSessionController(session.id),
      projection: stateMachine.getSnapshot(session.id),
      save: () => debouncedSaveSession(),
      refresh: () => this.syncContext(ctx),
    };
    return ctx;
  }

  private syncContext(ctx: SessionContext): void {
    const live = getSession(ctx.sessionId);
    if (live) {
      // 原位更新,保留 ctx 对象 identity(调用方可能缓存引用)
      (ctx as { session: ThreadSession }).session = live;
    }
    (ctx as { controller: AbortController | undefined }).controller = getSessionController(
      ctx.sessionId,
    );
    (ctx as { projection: SessionStateProjection }).projection = stateMachine.getSnapshot(
      ctx.sessionId,
    );
  }
}

export const sessionSupervisor = new SessionSupervisor();

/** 便捷读取:存在即返回 context,不存在返回 undefined。 */
export function getSessionContext(sessionId: string): SessionContext | undefined {
  return sessionSupervisor.get(sessionId);
}

/** 等同 `getSessionContext` 但在缺失时抛出,适合内部热路径。 */
export function requireSessionContext(sessionId: string): SessionContext {
  const ctx = sessionSupervisor.get(sessionId);
  if (!ctx) {
    throw new Error(`Session context missing: ${sessionId}`);
  }
  return ctx;
}
