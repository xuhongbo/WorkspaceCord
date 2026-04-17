// GateService — 统一的人工门控 facade
// 合并 GateCoordinator 和 GateManager 的职责：
//   - 包装 HumanGateRegistry(存储 + CAS)
//   - 管理内存回执句柄(receipt handles)
//   - 管理超时定时器(5 分钟过期)
//   - 可选注入 EventBus 发布 gate.created / gate.resolved 事件(P3a 将启用)
//
// 本次 P1 重构后,gateCoordinator 和 gateManager 都将 alias 到此服务的单例。

import type { ProviderName } from '@workspacecord/core';
import type { EventBus, EventType } from '@workspacecord/core';
import { getDomainBus, GateCreated, GateResolved } from '@workspacecord/core';
import { HumanGateRegistry, type HumanGateRecord } from './human-gate.ts';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface CreateGateParams {
  sessionId: string;
  provider: ProviderName;
  type: HumanGateRecord['type'];
  isBlocking: boolean;
  supportsRemoteDecision: boolean;
  summary: string;
  detail?: string;
  relatedCommand?: string;
  turn: number;
}

export interface ReceiptHandle {
  type: ProviderName;
  sessionId: string;
  resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void;
  reject: (reason: string) => void;
}

export interface InvalidatedGate {
  gateId: string;
  sessionId: string;
  discordMessageId?: string;
}

/** 重启后如何处理磁盘上残留的 pending gate。 */
export type GateRestartPolicy =
  /** 默认:全部标记为 invalidated,Discord 消息会被标灰。 */
  | 'invalidate-all'
  /** 续命:保留 pending 状态,按剩余时间重建 5 分钟超时,用户可继续审批。 */
  | 'resume-pending';

export interface GateReconcileResult {
  /** 本次 reconcile 过程中被标记为 invalidated 的 gates(仅 invalidate-all 策略)。 */
  invalidated: InvalidatedGate[];
  /** 仍保持 pending 状态并已重建超时的 gates(仅 resume-pending 策略)。 */
  resumed: HumanGateRecord[];
}

const GATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

// Domain event 类型(P3a 将激活订阅,当前仅发布)
const GATE_CREATED_EVENT = 'gate.created' as EventType<{
  gate: HumanGateRecord;
  gateId: string;
}>;

const GATE_RESOLVED_EVENT = 'gate.resolved' as EventType<{
  gateId: string;
  status: 'approved' | 'rejected';
  resolvedBy: 'discord' | 'terminal';
  resolvedAction: 'approve' | 'reject';
}>;

// ─── 服务 ────────────────────────────────────────────────────────────────────

export class GateService {
  private readonly registry: HumanGateRegistry;
  private readonly eventBus: EventBus | null;
  private readonly receiptHandles = new Map<string, ReceiptHandle>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();

  constructor(registry: HumanGateRegistry, eventBus: EventBus | null = null) {
    this.registry = registry;
    this.eventBus = eventBus;
  }

  /**
   * 启动时调用一次,把磁盘上的 gates.json 灌入内存。
   * 在此之前 getAll/getGate 都是空,historical bug:init 从未被调用 ⇒ 磁盘上的
   * pending gate 在重启后等同丢失。这里补齐闭环。
   */
  async init(): Promise<void> {
    await this.registry.init();
  }

  // ─── 创建 / 查询 ───────────────────────────────────────────────────────────

  createGate(params: CreateGateParams): HumanGateRecord {
    const record = this.registry.create(params);

    // 支持远程决策的阻塞型门控,默认 5 分钟超时
    if (record.supportsRemoteDecision && record.isBlocking) {
      this.setupTimeout(record.id);
    }

    this.emitCreated(record);
    return record;
  }

  getGate(gateId: string): HumanGateRecord | undefined {
    return this.registry.get(gateId);
  }

  getActiveGateForSession(sessionId: string): HumanGateRecord | undefined {
    return this.registry.getActiveBySession(sessionId)[0];
  }

  getAllGates(): HumanGateRecord[] {
    return this.registry.getAll();
  }

  // ─── 绑定 Discord 消息 ─────────────────────────────────────────────────────

  bindDiscordMessage(gateId: string, discordMessageId: string): boolean {
    const record = this.registry.get(gateId);
    if (!record || record.status !== 'pending') return false;
    const result = this.registry.update(gateId, record.version, { discordMessageId });
    return result.success;
  }

  // ─── 回执句柄 ──────────────────────────────────────────────────────────────

  /**
   * 注册回执句柄。仅保存在内存。
   * 若门控已不是 pending 状态,立即 reject。
   */
  registerReceiptHandle(
    gateId: string,
    handle: Omit<ReceiptHandle, 'gateId'>,
  ): void {
    const record = this.registry.get(gateId);
    if (!record || record.status !== 'pending') {
      handle.reject('门控不存在或已处理');
      return;
    }
    this.receiptHandles.set(gateId, handle as ReceiptHandle);
  }

  // ─── 解决门控 ──────────────────────────────────────────────────────────────

  async resolveFromDiscord(
    gateId: string,
    action: 'approve' | 'reject',
  ): Promise<{ success: boolean; message?: string; handledByReceipt: boolean }> {
    return this.resolveGate(gateId, action, 'discord');
  }

  /** 向后兼容别名(GateManager 旧 API)。 */
  async resolveGateFromDiscord(
    gateId: string,
    action: 'approve' | 'reject',
  ): Promise<{ success: boolean; message?: string }> {
    const result = await this.resolveFromDiscord(gateId, action);
    return { success: result.success, message: result.message };
  }

  /** 终端钩子通知已处理。同步调用。 */
  notifyTerminalResolved(
    gateId: string,
    action: 'approve' | 'reject',
  ): { success: boolean; message?: string; handledByReceipt: boolean } {
    return this.resolveGateSync(gateId, action, 'terminal');
  }

  private resolveGateSync(
    gateId: string,
    action: 'approve' | 'reject',
    source: 'discord' | 'terminal',
  ): { success: boolean; message?: string; handledByReceipt: boolean } {
    const record = this.registry.get(gateId);
    if (!record) return { success: false, message: '门控不存在', handledByReceipt: false };
    if (record.status !== 'pending') {
      return { success: false, message: '门控已被处理', handledByReceipt: false };
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    const result = this.registry.update(record.id, record.version, {
      status,
      resolvedAt: Date.now(),
      resolvedBy: source,
      resolvedAction: action,
    });

    if (!result.success) {
      return { success: false, message: result.message, handledByReceipt: false };
    }

    this.clearTimeout(gateId);
    this.emitResolved(gateId, status, source, action);

    const handle = this.receiptHandles.get(gateId);
    let handledByReceipt = false;
    if (handle) {
      handle.resolve(action, source);
      this.receiptHandles.delete(gateId);
      handledByReceipt = true;
    }

    return { success: true, handledByReceipt };
  }

  private async resolveGate(
    gateId: string,
    action: 'approve' | 'reject',
    source: 'discord' | 'terminal',
  ): Promise<{ success: boolean; message?: string; handledByReceipt: boolean }> {
    return this.resolveGateSync(gateId, action, source);
  }

  // ─── 超时 / 重启 / 清理 ────────────────────────────────────────────────────

  private setupTimeout(gateId: string): void {
    const timer = setTimeout(() => this.handleTimeout(gateId), GATE_TIMEOUT_MS);
    // 超时定时器不应阻塞进程关闭
    timer.unref?.();
    this.timeoutTimers.set(gateId, timer);
  }

  private clearTimeout(gateId: string): void {
    const timer = this.timeoutTimers.get(gateId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(gateId);
    }
  }

  private handleTimeout(gateId: string): void {
    const record = this.registry.get(gateId);
    if (!record || record.status !== 'pending') return;

    this.registry.update(record.id, record.version, {
      status: 'expired',
      resolvedAt: Date.now(),
      resolvedBy: 'timeout',
    });

    const handle = this.receiptHandles.get(gateId);
    if (handle) {
      handle.reject('审批超时（5 分钟）');
      this.receiptHandles.delete(gateId);
    }
    this.timeoutTimers.delete(gateId);
  }

  invalidateAllOnRestart(): InvalidatedGate[] {
    const invalidated: InvalidatedGate[] = [];

    for (const gate of this.registry.getAll()) {
      if (gate.status === 'pending') {
        invalidated.push({
          gateId: gate.id,
          sessionId: gate.sessionId,
          discordMessageId: gate.discordMessageId,
        });
      }
    }

    const count = this.registry.invalidateAll('restart');
    console.log(`[GateService] Invalidated ${count} pending gates on restart`);

    for (const [, handle] of this.receiptHandles) {
      handle.reject('restart');
    }
    this.receiptHandles.clear();

    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();

    return invalidated;
  }

  /**
   * 按策略对重启后残留的 pending gates 做 reconcile。
   * - `invalidate-all`:等同 `invalidateAllOnRestart`,返回被标为 invalidated 的清单。
   * - `resume-pending`:保持 pending 状态,对每个 blocking + remote 支持的 gate 按
   *   `createdAt + GATE_TIMEOUT_MS - now` 的剩余时间重建超时。已过期的直接按 timeout 处理。
   */
  reconcileOnStartup(policy: GateRestartPolicy): GateReconcileResult {
    if (policy === 'invalidate-all') {
      return { invalidated: this.invalidateAllOnRestart(), resumed: [] };
    }

    const now = Date.now();
    const resumed: HumanGateRecord[] = [];
    const invalidated: InvalidatedGate[] = [];

    for (const gate of this.registry.getAll()) {
      if (gate.status !== 'pending') continue;
      const age = now - gate.createdAt;

      if (age >= GATE_TIMEOUT_MS) {
        // 已超出 5 分钟窗口:不恢复,直接按 timeout 关闭
        this.registry.update(gate.id, gate.version, {
          status: 'expired',
          resolvedAt: now,
          resolvedBy: 'timeout',
        });
        invalidated.push({
          gateId: gate.id,
          sessionId: gate.sessionId,
          discordMessageId: gate.discordMessageId,
        });
        continue;
      }

      if (gate.supportsRemoteDecision && gate.isBlocking) {
        const remaining = GATE_TIMEOUT_MS - age;
        const timer = setTimeout(() => this.handleTimeout(gate.id), remaining);
        timer.unref?.();
        this.timeoutTimers.set(gate.id, timer);
      }
      resumed.push(gate);
    }

    console.log(
      `[GateService] Resumed ${resumed.length} pending gate(s), expired ${invalidated.length} overdue on restart`,
    );
    return { invalidated, resumed };
  }

  cleanupExpired(maxAgeMs: number = GATE_TIMEOUT_MS): number {
    const count = this.registry.cleanupExpired(maxAgeMs);
    // 同步 reject 已过期门控的回执句柄
    for (const gate of this.registry.getAll()) {
      if (gate.status === 'expired' && this.receiptHandles.has(gate.id)) {
        const handle = this.receiptHandles.get(gate.id)!;
        handle.reject('timeout');
        this.receiptHandles.delete(gate.id);
        this.clearTimeout(gate.id);
      }
    }
    return count;
  }

  archiveResolved(keepCount: number = 100): number {
    return this.registry.archiveResolved(keepCount);
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  private emitCreated(gate: HumanGateRecord): void {
    // 旧内部事件(向后兼容 gate-manager 测试 / GateManager 消费者)
    this.eventBus?.emit(GATE_CREATED_EVENT, { gate, gateId: gate.id }, 'gate-service');
    // P3a:新的 domain event,订阅者读取只读 payload 而非完整 gate 对象
    getDomainBus().emit(
      GateCreated,
      {
        gateId: gate.id,
        sessionId: gate.sessionId,
        provider: gate.provider,
        isBlocking: gate.isBlocking,
      },
      'gate-service',
    );
  }

  private emitResolved(
    gateId: string,
    status: 'approved' | 'rejected',
    source: 'discord' | 'terminal',
    action: 'approve' | 'reject',
  ): void {
    this.eventBus?.emit(
      GATE_RESOLVED_EVENT,
      { gateId, status, resolvedBy: source, resolvedAction: action },
      'gate-service',
    );
    getDomainBus().emit(
      GateResolved,
      { gateId, status, resolvedBy: source, resolvedAction: action },
      'gate-service',
    );
  }
}

// ─── 默认单例（向后兼容 gateCoordinator / GateManager 的用法）─────────────────

import { humanGateRegistry } from './human-gate.ts';

/**
 * 默认全局 GateService 实例。EventBus 暂不注入（P3a 会接入）。
 * 外部模块应通过 `gateService` 而不是直接 new。
 */
export const gateService = new GateService(humanGateRegistry, null);

/** 允许测试在创建 session 前重新绑定 eventBus。 */
export function _setGateServiceEventBus(bus: EventBus | null): void {
  // 这里不替换 singleton,仅在生产集成时 P3a 会重新构造。
  // 当前实现留作占位,避免对外暴露 GateService 内部字段。
  void bus;
}
