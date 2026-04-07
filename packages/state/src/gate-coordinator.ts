// 人工门控协调器
// 实现设计文档第 10.3 节：双入口协调
// 参考：docs/superpowers/specs/2026-03-31-local-session-realtime-sync-and-human-gates-design.md

import type { HumanGateRecord, HumanGateResolveSource } from './human-gate.ts';
import { HumanGateRegistry } from './human-gate.ts';
import type { ProviderName } from '@workspacecord/core';

// ─── 回执句柄（仅内存，不持久化）─────────────────────────────────────────────

interface ClaudeReceiptHandle {
  type: 'claude';
  sessionId: string;
  gateId: string;
  resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void;
  reject: (reason: string) => void;
}

interface CodexReceiptHandle {
  type: 'codex';
  sessionId: string;
  gateId: string;
  resolve: (action: 'approve' | 'reject', source: 'discord' | 'terminal') => void;
  reject: (reason: string) => void;
}

type ReceiptHandle = ClaudeReceiptHandle | CodexReceiptHandle;

// ─── 门控协调器 ───────────────────────────────────────────────────────────────

export class GateCoordinator {
  private registry: HumanGateRegistry;
  private receiptHandles: Map<string, ReceiptHandle> = new Map();
  private timeoutTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(registry: HumanGateRegistry) {
    this.registry = registry;
  }

  /**
   * 创建新的人工门控
   */
  createGate(params: {
    sessionId: string;
    provider: ProviderName;
    type: HumanGateRecord['type'];
    isBlocking: boolean;
    supportsRemoteDecision: boolean;
    summary: string;
    detail?: string;
    relatedCommand?: string;
    turn: number;
  }): HumanGateRecord {
    const record = this.registry.create(params);

    // 如果支持远程决策且是阻塞型，设置 5 分钟超时
    if (record.supportsRemoteDecision && record.isBlocking) {
      this.setupTimeout(record.id);
    }

    return record;
  }

  /**
   * 注册回执句柄（仅内存，不持久化）
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
    this.receiptHandles.set(gateId, { ...handle, gateId } as ReceiptHandle);
  }

  /**
   * 绑定 Discord 交互卡消息 ID
   */
  bindDiscordMessage(gateId: string, discordMessageId: string): boolean {
    const record = this.registry.get(gateId);
    if (!record) {
      return false;
    }

    const result = this.registry.update(gateId, record.version, { discordMessageId });
    return result.success;
  }

  /**
   * 尝试通过 Discord 解决门控（CAS 更新）
   */
  async resolveFromDiscord(
    gateId: string,
    action: 'approve' | 'reject',
  ): Promise<{ success: boolean; message?: string; handledByReceipt: boolean }> {
    const record = this.registry.get(gateId);

    if (!record) {
      return { success: false, message: '门控不存在', handledByReceipt: false };
    }

    if (record.status !== 'pending') {
      return { success: false, message: '门控已被处理', handledByReceipt: false };
    }

    // CAS 更新
    const result = this.registry.update(record.id, record.version, {
      status: action === 'approve' ? 'approved' : 'rejected',
      resolvedAt: Date.now(),
      resolvedBy: 'discord',
      resolvedAction: action,
    });

    if (!result.success) {
      return { success: false, message: result.message, handledByReceipt: false };
    }

    // 清理超时定时器
    this.clearTimeout(gateId);

    // 如果有回执句柄，调用它
    const handle = this.receiptHandles.get(gateId);
    let handledByReceipt = false;
    if (handle) {
      handle.resolve(action, 'discord');
      this.receiptHandles.delete(gateId);
      handledByReceipt = true;
    }

    return { success: true, handledByReceipt };
  }

  /**
   * 通知终端已处理（由钩子调用）
   */
  notifyTerminalResolved(
    gateId: string,
    action: 'approve' | 'reject',
  ): { success: boolean; message?: string; handledByReceipt: boolean } {
    const record = this.registry.get(gateId);

    if (!record) {
      return { success: false, message: '门控不存在', handledByReceipt: false };
    }

    if (record.status !== 'pending') {
      return { success: false, message: '门控已被处理', handledByReceipt: false };
    }

    // CAS 更新
    const result = this.registry.update(record.id, record.version, {
      status: action === 'approve' ? 'approved' : 'rejected',
      resolvedAt: Date.now(),
      resolvedBy: 'terminal',
      resolvedAction: action,
    });

    if (!result.success) {
      return { success: false, message: result.message, handledByReceipt: false };
    }

    // 清理超时定时器
    this.clearTimeout(gateId);

    // 通知本地阻塞句柄（如果存在）
    const handle = this.receiptHandles.get(gateId);
    let handledByReceipt = false;
    if (handle) {
      handle.resolve(action, 'terminal');
      this.receiptHandles.delete(gateId);
      handledByReceipt = true;
    }

    return { success: true, handledByReceipt };
  }

  /**
   * 设置超时定时器（5 分钟）
   */
  private setupTimeout(gateId: string): void {
    const timer = setTimeout(() => {
      this.handleTimeout(gateId);
    }, 5 * 60 * 1000); // 5 分钟

    this.timeoutTimers.set(gateId, timer);
  }

  /**
   * 清理超时定时器
   */
  private clearTimeout(gateId: string): void {
    const timer = this.timeoutTimers.get(gateId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(gateId);
    }
  }

  /**
   * 处理超时
   */
  private handleTimeout(gateId: string): void {
    const record = this.registry.get(gateId);

    if (!record || record.status !== 'pending') {
      return;
    }

    // 标记为过期
    this.registry.update(record.id, record.version, {
      status: 'expired',
      resolvedAt: Date.now(),
      resolvedBy: 'timeout',
    });

    // 如果有回执句柄，拒绝它
    const handle = this.receiptHandles.get(gateId);
    if (handle) {
      handle.reject('审批超时（5 分钟）');
      this.receiptHandles.delete(gateId);
    }

    this.timeoutTimers.delete(gateId);
  }

  /**
   * 重启时失效所有待处理门控
   */
  invalidateAllOnRestart(): Array<{ gateId: string; discordMessageId?: string }> {
    const count = this.registry.invalidateAll('restart');
    console.log(`[GateCoordinator] Invalidated ${count} pending gates on restart`);

    // 返回需要更新 Discord 消息的门控列表
    const toUpdate: Array<{ gateId: string; discordMessageId?: string }> = [];
    for (const gate of this.registry.getAll()) {
      if (gate.status === 'invalidated' && gate.discordMessageId) {
        toUpdate.push({
          gateId: gate.id,
          discordMessageId: gate.discordMessageId,
        });
      }
    }

    // 清理所有回执句柄和定时器
    this.receiptHandles.clear();
    for (const timer of this.timeoutTimers.values()) {
      clearTimeout(timer);
    }
    this.timeoutTimers.clear();

    return toUpdate;
  }

  /**
   * 获取门控记录
   */
  getGate(gateId: string): HumanGateRecord | undefined {
    return this.registry.get(gateId);
  }

  /**
   * 获取会话的活跃门控
   */
  getActiveGateForSession(sessionId: string): HumanGateRecord | undefined {
    const active = this.registry.getActiveBySession(sessionId);
    return active[0]; // 返回第一个活跃门控
  }

  /**
   * 清理过期门控
   */
  cleanupExpired(): number {
    return this.registry.cleanupExpired();
  }

  /**
   * 归档已解决门控，保留最近 N 条
   */
  archiveResolved(keepCount: number = 100): number {
    return this.registry.archiveResolved(keepCount);
  }
}

// 导出单例
import { humanGateRegistry } from './human-gate.ts';
export const gateCoordinator = new GateCoordinator(humanGateRegistry);
