// 常驻状态卡：固定在频道顶部的状态展示
// 参考设计文档 5.1

import {
  EmbedBuilder,
  type TextChannel,
  type AnyThreadChannel,
  type Message,
} from 'discord.js';
import type { UnifiedState, TodoItem, SessionContextFields } from '@workspacecord/state';
import { STATE_LABELS, STATE_COLORS } from '@workspacecord/state';
import { truncate } from '@workspacecord/core';

/**
 * Single source of truth for the data required to render the status card.
 * Shared by `initialize`, `update`, `buildEmbed`, and the projection renderer.
 */
export interface StatusCardViewData extends SessionContextFields {
  turn: number;
  updatedAt: number;
  phase?: string;
  remoteHumanControl?: boolean;
  provider?: 'claude' | 'codex';
  permissionsSummary?: string;
  verbose?: boolean;
  monitorGoal?: string;
  monitorIteration?: number;
  maxMonitorIterations?: number;
}

export class StatusCard {
  private messageId: string | null = null;
  private channel: TextChannel | AnyThreadChannel;
  private lastState: UnifiedState = 'idle';
  private lastData: StatusCardViewData | null = null;

  constructor(channel: TextChannel | AnyThreadChannel) {
    this.channel = channel;
  }

  adopt(messageId: string): void {
    this.messageId = messageId;
  }

  getMessageId(): string | null {
    return this.messageId;
  }

  async initialize(data: Partial<StatusCardViewData> = {}): Promise<void> {
    const payload = {
      turn: data.turn ?? 1,
      updatedAt: data.updatedAt ?? Date.now(),
      phase: data.phase,
      remoteHumanControl: data.remoteHumanControl,
      provider: data.provider,
      permissionsSummary: data.permissionsSummary,
    };
    this.lastState = 'idle';
    this.lastData = payload;

    if (this.messageId) {
      await this.update('idle', payload);
      return;
    }

    const embed = this.buildEmbed('idle', payload);
    await this.sendNewMessage(embed);
  }

  async update(state: UnifiedState, data: StatusCardViewData): Promise<void> {
    this.lastState = state;
    this.lastData = { ...data };
    const embed = this.buildEmbed(state, data);
    if (!this.messageId) {
      await this.sendNewMessage(embed);
      return;
    }
    await this.editExistingMessage(embed);
  }

  async recreateAtBottom(): Promise<{ oldMessageId?: string; newMessageId: string } | null> {
    if (!this.messageId || !this.lastData) return null;

    const oldMessageId = this.messageId;
    const embed = this.buildEmbed(this.lastState, this.lastData);
    const msg = await this.channel.send({ embeds: [embed] });
    this.messageId = msg.id;
    return { oldMessageId, newMessageId: msg.id };
  }

  private async sendNewMessage(embed: EmbedBuilder): Promise<void> {
    try {
      const msg = await this.channel.send({ embeds: [embed] });
      this.messageId = msg.id;
    } catch (error) {
      console.error('状态卡创建失败:', error);
      throw error;
    }
  }

  private async editExistingMessage(embed: EmbedBuilder): Promise<void> {
    if (!this.messageId) {
      await this.sendNewMessage(embed);
      return;
    }

    try {
      // 使用 PATCH 更新现有消息，而非删除后重建
      const msg = await this.channel.messages.edit(this.messageId, {
        embeds: [embed],
        components: [],
      });
      this.messageId = msg.id;
    } catch (error) {
      // 如果消息不存在或无法编辑，降级为创建新消息
      console.warn(`状态卡编辑失败 (${this.messageId}), 创建新消息:`, error);
      await this.sendNewMessage(embed);
    }
  }

  private buildEmbed(state: UnifiedState, data: StatusCardViewData): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(STATE_COLORS[state])
      .setTitle(`🤖 ${STATE_LABELS[state]}`)
      .addFields(
        { name: '轮次', value: `#${data.turn}`, inline: true },
        { name: '更新', value: `<t:${Math.floor(data.updatedAt / 1000)}:R>`, inline: true },
      )
      .setTimestamp();

    // 添加受管/非受管标签（仅 Codex 会话显示）
    if (data.provider === 'codex') {
      const managedLabel = data.remoteHumanControl
        ? '✓ 受管会话'
        : '○ 非受管会话（仅状态监控）';
      embed.addFields({ name: '会话类型', value: managedLabel, inline: true });
    }

    if (data.phase) {
      const sanitizedPhase = this.sanitizePhase(data.phase);
      if (sanitizedPhase) {
        embed.addFields({ name: '阶段', value: sanitizedPhase, inline: true });
      }
    }

    if (data.verbose !== undefined) {
      embed.addFields({ name: '输出', value: data.verbose ? '🔊 详细' : '🔇 精简', inline: true });
    }

    if (data.monitorGoal) {
      embed.addFields({ name: '监控目标', value: truncate(data.monitorGoal, 150) });
    }
    if (data.monitorIteration !== undefined && data.maxMonitorIterations !== undefined) {
      embed.addFields({ name: '迭代', value: `${data.monitorIteration}/${data.maxMonitorIterations}`, inline: true });
    }

    if (data.permissionsSummary) {
      embed.addFields({ name: '权限', value: data.permissionsSummary, inline: false });
    }

    if (data.todoList && data.todoList.length > 0) {
      const rendered = this.renderTodoList(data.todoList);
      if (rendered) {
        const completed = data.todoList.filter((t) => t.completed).length;
        embed.addFields({
          name: `待办（${completed}/${data.todoList.length}）`,
          value: rendered,
          inline: false,
        });
      }
    }

    if (data.batchApprovalMode) {
      const pending = data.pendingApprovals ?? [];
      const queueLine = pending.length === 0
        ? '队列为空'
        : pending
            .slice(0, 5)
            .map((a) => `• ${truncate(a.toolName, 32)} — ${truncate(a.detail, 80)}`)
            .join('\n');
      embed.addFields({
        name: `批量审批（${pending.length} 待批）`,
        value: queueLine + (pending.length > 5 ? `\n…还有 ${pending.length - 5} 条` : ''),
        inline: false,
      });
    }

    if (data.recentPermissionDenials && data.recentPermissionDenials.length > 0) {
      const lines = data.recentPermissionDenials
        .slice(0, 3)
        .map((d) => `⛔ ${truncate(d.toolName, 28)} — ${truncate(d.reason, 80)}`)
        .join('\n');
      embed.addFields({ name: '最近拒绝', value: lines, inline: false });
    }

    return embed;
  }

  private renderTodoList(items: TodoItem[]): string {
    // Discord embed field value is capped at 1024 chars; stay well under to leave
    // room for the prefix/suffix and embed overhead.
    const TOTAL_BUDGET = 950;
    const MAX_LINES = 8;
    const MAX_CHAR_PER_LINE = 180;

    const lines: string[] = [];
    let used = 0;
    let renderedCount = 0;

    for (const item of items.slice(0, MAX_LINES)) {
      const mark = item.completed ? '☑' : '☐';
      const line = `${mark} ${truncate(item.text, MAX_CHAR_PER_LINE)}`;
      // +1 accounts for the newline that `join('\n')` will add between lines.
      const cost = (lines.length > 0 ? 1 : 0) + line.length;
      if (used + cost > TOTAL_BUDGET) break;
      lines.push(line);
      used += cost;
      renderedCount++;
    }

    const hidden = items.length - renderedCount;
    if (hidden > 0) {
      const more = `… 还有 ${hidden} 项`;
      const cost = (lines.length > 0 ? 1 : 0) + more.length;
      if (used + cost <= TOTAL_BUDGET) lines.push(more);
    }

    return lines.join('\n');
  }

  /**
   * Sanitize phase text for status card display.
   * Returns cleaned text or empty string if unsuitable.
   */
  private sanitizePhase(description: string): string {
    let normalized = description.trim();
    if (!normalized) return '';

    // Strip code blocks, diffs, and file lists — these don't belong in a status card
    if (normalized.includes('```') || /diff --git/.test(normalized) || this.isLikelyFileList(normalized)) {
      console.warn(`[StatusCard] Phase contains unsuitable content, stripping: ${normalized.slice(0, 60)}...`);
      return '';
    }

    // Truncate to 200 chars
    if (normalized.length > 200) {
      normalized = normalized.slice(0, 197) + '...';
    }

    return normalized;
  }

  validate(description?: string): void {
    if (!description) return;
    const normalized = description.trim();
    if (!normalized) return;

    if (normalized.length > 200) {
      throw new Error('状态卡描述过长，应移至摘要卡或结果消息');
    }
    if (normalized.includes('```')) {
      throw new Error('状态卡不应包含代码块');
    }
    if (/diff --git/.test(normalized)) {
      throw new Error('状态卡不应包含 diff');
    }
    if (this.isLikelyFileList(normalized)) {
      throw new Error('状态卡不应包含文件列表');
    }
  }

  private isLikelyFileList(text: string): boolean {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return false;
    return lines.every((line) => /^[-+*]\s+[\w./\\-]+$/.test(line));
  }
}
