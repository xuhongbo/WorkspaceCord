// 总结处理器：区分本轮总结和结束总结
// 参考设计文档 5.5

import { EmbedBuilder, type TextChannel, type AnyThreadChannel } from 'discord.js';
import type { StatusCard } from './status-card.ts';

export class SummaryHandler {
  private channel: TextChannel | AnyThreadChannel;
  private statusCard: StatusCard;
  private digestMessageIds: string[] = [];

  constructor(channel: TextChannel | AnyThreadChannel, statusCard: StatusCard) {
    this.channel = channel;
    this.statusCard = statusCard;
  }

  async sendTurnSummary(content: string, turn: number): Promise<void> {
    const chunks = this.splitIfNeeded(content);

    for (let i = 0; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setDescription(chunks[i])
        .setTimestamp();

      if (i === 0) embed.setTitle('✅ 本轮完成');
      if (chunks.length > 1) embed.setFooter({ text: `第 ${i + 1}/${chunks.length} 部分` });

      await this.channel.send({ embeds: [embed] });
    }

    // 状态回落到 idle
    await this.statusCard.update('idle', { turn: turn + 1, updatedAt: Date.now() });
  }

  async sendTurnFailure(content: string, turn: number): Promise<void> {
    const chunks = this.splitIfNeeded(content);

    for (let i = 0; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setDescription(chunks[i])
        .setTimestamp();

      if (i === 0) embed.setTitle('❌ 本轮失败');
      if (chunks.length > 1) embed.setFooter({ text: `第 ${i + 1}/${chunks.length} 部分` });

      await this.channel.send({ embeds: [embed] });
    }

    await this.statusCard.update('error', { turn, updatedAt: Date.now() });
  }

  async sendEndingSummary(content: string): Promise<void> {
    const chunks = this.splitIfNeeded(content);

    for (let i = 0; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setColor(0x808080)
        .setDescription(chunks[i])
        .setTimestamp();

      if (i === 0) embed.setTitle('🏁 会话结束');
      if (chunks.length > 1) embed.setFooter({ text: `第 ${i + 1}/${chunks.length} 部分` });

      await this.channel.send({ embeds: [embed] });
    }

    // 状态进入 offline
    await this.statusCard.update('offline', { turn: 0, updatedAt: Date.now() });
  }

  async sendDigestSummary(content: string): Promise<void> {
    const chunks = this.splitIfNeeded(content);
    if (chunks.length === 0) return;

    const nextMessageIds: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setDescription(chunks[i])
        .setTimestamp();

      if (i === 0) embed.setTitle('📌 最近摘要');
      if (chunks.length > 1) {
        embed.setFooter({ text: `第 ${i + 1}/${chunks.length} 部分` });
      } else {
        embed.setFooter({ text: `更新于 <t:${Math.floor(Date.now() / 1000)}:R>` });
      }

      const existingId = this.digestMessageIds[i];
      if (existingId) {
        try {
          await this.channel.messages.edit(existingId, { embeds: [embed] });
          nextMessageIds.push(existingId);
          continue;
        } catch {
          // fall through to re-send below
        }
      }

      const message = await this.channel.send({ embeds: [embed] });
      nextMessageIds.push(message.id);
    }

    for (const staleId of this.digestMessageIds.slice(chunks.length)) {
      await this.channel.messages.delete(staleId).catch(() => {});
    }

    this.digestMessageIds = nextMessageIds;
  }

  private splitIfNeeded(content: string): string[] {
    const MAX_LENGTH = 1900; // 留 buffer
    if (!content.trim()) return [];
    if (content.length <= MAX_LENGTH) return [content];

    const chunks: string[] = [];
    let current = '';

    const sentences = content.split(/(?<=[.!?。！？])\s+/);

    for (const sentence of sentences) {
      if (current.length + sentence.length > MAX_LENGTH) {
        if (current) {
          chunks.push(current.trim());
          current = '';
        }
        if (sentence.length > MAX_LENGTH) {
          for (let i = 0; i < sentence.length; i += MAX_LENGTH) {
            chunks.push(sentence.slice(i, i + MAX_LENGTH));
          }
        } else {
          current = sentence;
        }
      } else {
        current += (current ? ' ' : '') + sentence;
      }
    }

    if (current) chunks.push(current.trim());
    return chunks;
  }
}
