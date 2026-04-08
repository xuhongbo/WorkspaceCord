// 常驻状态卡：固定在频道顶部的状态展示
// 参考设计文档 5.1

import {
  EmbedBuilder,
  type TextChannel,
  type AnyThreadChannel,
  type Message,
} from 'discord.js';
import type { UnifiedState } from '@workspacecord/state';
import { STATE_LABELS, STATE_COLORS } from '@workspacecord/state';

export class StatusCard {
  private messageId: string | null = null;
  private channel: TextChannel | AnyThreadChannel;
  private lastState: UnifiedState = 'idle';
  private lastData: {
    turn: number;
    updatedAt: number;
    phase?: string;
    remoteHumanControl?: boolean;
    provider?: 'claude' | 'codex';
    permissionsSummary?: string;
  } | null = null;

  constructor(channel: TextChannel | AnyThreadChannel) {
    this.channel = channel;
  }

  adopt(messageId: string): void {
    this.messageId = messageId;
  }

  getMessageId(): string | null {
    return this.messageId;
  }

  async initialize(data: {
    turn?: number;
    updatedAt?: number;
    phase?: string;
    remoteHumanControl?: boolean;
    provider?: 'claude' | 'codex';
    permissionsSummary?: string;
  } = {}): Promise<void> {
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

  async update(
    state: UnifiedState,
    data: {
      turn: number;
      updatedAt: number;
      phase?: string;
      remoteHumanControl?: boolean;
      provider?: 'claude' | 'codex';
      permissionsSummary?: string;
    },
  ): Promise<void> {
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

  private buildEmbed(
    state: UnifiedState,
    data: {
      turn: number;
      updatedAt: number;
      phase?: string;
      remoteHumanControl?: boolean;
      provider?: 'claude' | 'codex';
      permissionsSummary?: string;
    },
  ): EmbedBuilder {
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

    if (data.permissionsSummary) {
      embed.addFields({ name: '权限', value: data.permissionsSummary, inline: false });
    }

    return embed;
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
