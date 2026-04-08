// 人工门控运行时注册表
// 参考设计文档：2026-03-31-local-session-realtime-sync-and-human-gates-design.md
// 第 10.3.1 节：并发安全机制

import { Store } from '@workspacecord/core';
import type { ProviderName } from '@workspacecord/core';

// ─── 门控类型与状态 ───────────────────────────────────────────────────────────

export type HumanGateType = 'binary_approval' | 'text_question' | 'notification';

export type HumanGateStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated';

export type HumanGateResolveSource = 'terminal' | 'discord' | 'timeout' | 'restart';

// ─── 门控记录 ─────────────────────────────────────────────────────────────────

export interface HumanGateRecord {
  id: string; // 唯一编号
  version: number; // 乐观锁版本号（用于 CAS 更新）
  sessionId: string; // 所属会话
  provider: ProviderName; // 提供方
  type: HumanGateType; // 门控类型
  isBlocking: boolean; // 是否阻塞
  supportsRemoteDecision: boolean; // 是否支持 Discord 决策
  summary: string; // 摘要
  detail?: string; // 详细信息
  relatedCommand?: string; // 关联命令
  createdAt: number; // 创建时间
  status: HumanGateStatus; // 当前状态
  resolvedAt?: number; // 解决时间
  resolvedBy?: HumanGateResolveSource; // 解决来源
  resolvedAction?: 'approve' | 'reject' | 'answer'; // 解决动作
  answerText?: string; // 文本回答（仅 text_question 类型）
  discordMessageId?: string; // Discord 交互卡消息 ID
  turn: number; // 所属轮次
}

// ─── CAS 更新结果 ─────────────────────────────────────────────────────────────

export interface CASUpdateResult {
  success: boolean;
  record?: HumanGateRecord;
  error?: 'not_found' | 'version_conflict' | 'invalid_transition';
  message?: string;
}

// ─── 门控注册表 ───────────────────────────────────────────────────────────────

export class HumanGateRegistry {
  private gates: Map<string, HumanGateRecord> = new Map();
  private store: Store<HumanGateRecord[]>;

  constructor() {
    this.store = new Store<HumanGateRecord[]>('gates.json');
  }

  /** Load persisted gates from disk. Call during startup before using the registry. */
  async init(): Promise<void> {
    try {
      const data = await this.store.read();
      if (data && Array.isArray(data)) {
        for (const record of data) {
          this.gates.set(record.id, record);
        }
      }
    } catch (err) {
      console.error('[HumanGateRegistry] Failed to load persisted gates:', err);
    }
  }

  private async _save(): Promise<void> {
    return this.store.write(Array.from(this.gates.values())).catch((err: unknown) => {
      console.error('[HumanGateRegistry] Failed to persist gates:', err);
    });
  }

  // 创建新门控
  create(params: Omit<HumanGateRecord, 'id' | 'version' | 'createdAt' | 'status'>): HumanGateRecord {
    const id = this.generateId();
    const record: HumanGateRecord = {
      ...params,
      id,
      version: 1,
      createdAt: Date.now(),
      status: 'pending',
    };
    this.gates.set(id, record);
    this._save();
    return record;
  }

  // 获取门控记录
  get(id: string): HumanGateRecord | undefined {
    return this.gates.get(id);
  }

  // 获取会话的所有门控
  getBySession(sessionId: string): HumanGateRecord[] {
    return Array.from(this.gates.values()).filter((g) => g.sessionId === sessionId);
  }

  // 获取会话的活跃门控（pending 状态）
  getActiveBySession(sessionId: string): HumanGateRecord[] {
    return this.getBySession(sessionId).filter((g) => g.status === 'pending');
  }

  // CAS 更新：使用乐观锁保证原子性
  update(
    id: string,
    expectedVersion: number,
    updates: Partial<Omit<HumanGateRecord, 'id' | 'version' | 'createdAt'>>,
  ): CASUpdateResult {
    const current = this.gates.get(id);

    if (!current) {
      return {
        success: false,
        error: 'not_found',
        message: `Gate ${id} not found`,
      };
    }

    if (current.version !== expectedVersion) {
      return {
        success: false,
        error: 'version_conflict',
        message: `Version conflict: expected ${expectedVersion}, got ${current.version}`,
      };
    }

    // 验证状态转换合法性
    if (updates.status && !this.isValidTransition(current.status, updates.status)) {
      return {
        success: false,
        error: 'invalid_transition',
        message: `Invalid transition: ${current.status} -> ${updates.status}`,
      };
    }

    // 应用更新并递增版本号
    const updated: HumanGateRecord = {
      ...current,
      ...updates,
      version: current.version + 1,
    };

    this.gates.set(id, updated);

    this._save();

    return {
      success: true,
      record: updated,
    };
  }

  // 批量失效门控（用于重启后清理）
  invalidateAll(reason: HumanGateResolveSource = 'restart'): number {
    let count = 0;
    for (const [id, gate] of this.gates.entries()) {
      if (gate.status === 'pending') {
        const updated: HumanGateRecord = {
          ...gate,
          status: 'invalidated',
          resolvedAt: Date.now(),
          resolvedBy: reason,
          version: gate.version + 1,
        };
        this.gates.set(id, updated);
        count++;
      }
    }
    this._save();
    return count;
  }

  // 删除门控记录
  delete(id: string): boolean {
    const result = this.gates.delete(id);
    if (result) this._save();
    return result;
  }

  // 清理过期门控（超过指定时间未解决）
  cleanupExpired(maxAgeMs: number = 5 * 60 * 1000): number {
    const now = Date.now();
    let count = 0;

    for (const [id, gate] of this.gates.entries()) {
      if (gate.status === 'pending' && now - gate.createdAt >= maxAgeMs) {
        const updated: HumanGateRecord = {
          ...gate,
          status: 'expired',
          resolvedAt: now,
          resolvedBy: 'timeout',
          version: gate.version + 1,
        };
        this.gates.set(id, updated);
        count++;
      }
    }

    this._save();
    return count;
  }

  // 归档已解决的门控（保留最近 N 条）
  archiveResolved(keepCount: number = 100): number {
    const resolved = Array.from(this.gates.values())
      .filter((g) => g.status !== 'pending')
      .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));

    if (resolved.length <= keepCount) {
      return 0;
    }

    const toArchive = resolved.slice(keepCount);
    for (const gate of toArchive) {
      this.gates.delete(gate.id);
    }

    this._save();
    return toArchive.length;
  }

  // 获取所有门控（用于调试）
  getAll(): HumanGateRecord[] {
    return Array.from(this.gates.values());
  }

  // 获取统计信息
  getStats(): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    invalidated: number;
  } {
    const all = this.getAll();
    return {
      total: all.length,
      pending: all.filter((g) => g.status === 'pending').length,
      approved: all.filter((g) => g.status === 'approved').length,
      rejected: all.filter((g) => g.status === 'rejected').length,
      expired: all.filter((g) => g.status === 'expired').length,
      invalidated: all.filter((g) => g.status === 'invalidated').length,
    };
  }

  // 验证状态转换合法性
  private isValidTransition(from: HumanGateStatus, to: HumanGateStatus): boolean {
    const validTransitions: Record<HumanGateStatus, HumanGateStatus[]> = {
      pending: ['approved', 'rejected', 'expired', 'invalidated'],
      approved: [], // 终态
      rejected: [], // 终态
      expired: [], // 终态
      invalidated: [], // 终态
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  // 生成唯一 ID
  private generateId(): string {
    return `gate_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}


// 导出单例
export const humanGateRegistry = new HumanGateRegistry();
