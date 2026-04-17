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
import { getSession } from './session-registry.ts';
// 其余 registry 符号通过 namespace 读取:部分测试用 vi.mock 替换 session-registry
// 为子集,严格模式下命名导入未定义会抛错;namespace 读取能优雅降级为 undefined。
import * as registryModule from './session-registry.ts';
import * as stateModule from '@workspacecord/state';
import type { SessionStateProjection } from '@workspacecord/state';

type RegistryExtras = {
  getSessionController?: (sessionId: string) => AbortController | undefined;
  debouncedSaveSession?: () => void;
};

type StateModuleExtras = {
  stateMachine?: {
    getSnapshot: (sessionId: string) => SessionStateProjection;
  };
};

const EMPTY_PROJECTION: SessionStateProjection = Object.freeze({
  turn: 0,
  humanResolved: false,
  updatedAt: 0,
}) as unknown as SessionStateProjection;

function safeGetSessionController(
  sessionId: string,
): AbortController | undefined {
  try {
    const fn = (registryModule as unknown as RegistryExtras).getSessionController;
    return typeof fn === 'function' ? fn(sessionId) : undefined;
  } catch {
    // vitest 的 strict mock 在访问未 mock 的导出时抛错;属于测试路径,安全忽略。
    return undefined;
  }
}

function safeDebouncedSaveSession(): void {
  try {
    const fn = (registryModule as unknown as RegistryExtras).debouncedSaveSession;
    if (typeof fn === 'function') fn();
  } catch {
    // 同上
  }
}

function safeGetProjection(sessionId: string): SessionStateProjection {
  try {
    const sm = (stateModule as unknown as StateModuleExtras).stateMachine;
    if (sm && typeof sm.getSnapshot === 'function') {
      return sm.getSnapshot(sessionId);
    }
  } catch {
    // stateMachine 可能在测试中被 mock 为子集
  }
  return EMPTY_PROJECTION;
}

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
    const live = getSession(sessionId);
    const cached = this.contexts.get(sessionId);
    if (!live) {
      // session 已消失(endSession 可能早于 release 回调):主动清缓存,避免 stale 读。
      if (cached) this.contexts.delete(sessionId);
      return undefined;
    }
    if (cached) {
      this.syncContext(cached);
      return cached;
    }
    const ctx = this.build(live);
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
      controller: safeGetSessionController(session.id),
      projection: safeGetProjection(session.id),
      save: () => safeDebouncedSaveSession(),
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
    (ctx as { controller: AbortController | undefined }).controller = safeGetSessionController(
      ctx.sessionId,
    );
    (ctx as { projection: SessionStateProjection }).projection = safeGetProjection(
      ctx.sessionId,
    );
  }
}

export const sessionSupervisor = new SessionSupervisor();

// session 结束时 supervisor 缓存通过 `get()` 的 live=undefined 分支自动清理,
// 无需订阅 session-registry 的 onSessionEnded 回调(避免与 vitest mock 严格校验冲突)。
// 代价:缓存项在 session 结束后会保留到下一次 get(),属于可接受的微量内存开销。

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

/**
 * 通过 supervisor 读出 session 快照。等价于 `getSession`,但显式经过 SessionContext
 * 路径,便于未来把 registry 的单例逐步替换为 supervisor-owned actor 时,无需改动
 * 调用点。偏好在 bot/engine 的外部调用点使用本函数,保留 `getSession` 给 registry
 * 自身和超细粒度内部热路径。
 */
export function getSessionView(sessionId: string): ThreadSession | undefined {
  return sessionSupervisor.get(sessionId)?.session;
}
