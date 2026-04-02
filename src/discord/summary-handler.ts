// 总结处理器：区分本轮总结和结束总结
// 参考设计文档 5.5

import { EmbedBuilder, type TextChannel, type AnyThreadChannel } from 'discord.js';
import { config } from '../config.ts';
import type { StatusCard } from './status-card.ts';
import { buildDeliveryPlan, chunkText } from './delivery-policy.ts';
import { deliver } from './delivery.ts';

export class SummaryHandler {
  private sessionId: string;
  private chatId: string;
  private channel: TextChannel | AnyThreadChannel;
  private statusCard: StatusCard;
  private digestMessageIds: string[] = [];

  constructor(
    sessionId: string,
    chatId: string,
    channel: TextChannel | AnyThreadChannel,
    statusCard: StatusCard,
  ) {
    this.sessionId = sessionId;
    this.chatId = chatId;
    this.channel = channel;
    this.statusCard = statusCard;
  }

  async sendTurnSummary(
    content: string,
    turn: number,
    replyToMessageId?: string,
    attachments: string[] = [],
  ): Promise<void> {
    await this.sendFinalSummaryMessage(
      'user_reply',
      '✅ 本轮完成\n\n',
      content,
      replyToMessageId,
      attachments,
    );
    await this.statusCard.update('idle', { turn: turn + 1, updatedAt: Date.now() });
  }

  async sendTurnFailure(
    content: string,
    turn: number,
    replyToMessageId?: string,
    attachments: string[] = [],
  ): Promise<void> {
    await this.sendFinalSummaryMessage(
      'user_reply',
      '❌ 本轮失败\n\n',
      content,
      replyToMessageId,
      attachments,
    );
    await this.statusCard.update('error', { turn, updatedAt: Date.now() });
  }

  async sendEndingSummary(content: string, attachments: string[] = []): Promise<void> {
    await this.sendFinalSummaryMessage(
      'system_notice',
      '🏁 会话结束\n\n',
      content,
      undefined,
      attachments,
    );
    await this.statusCard.update('offline', { turn: 0, updatedAt: Date.now() });
  }

  async sendDigestSummary(content: string): Promise<void> {
    const chunks = this.splitIfNeeded(content);
    if (chunks.length === 0) return;

    const nextMessageIds: string[] = new Array(chunks.length);
    const staleMessageIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const existingId = this.digestMessageIds[i];
      if (existingId) {
        const embed = this.buildDigestEmbed(chunks[i], i, chunks.length);
        try {
          await this.channel.messages.edit(existingId, { embeds: [embed] });
          nextMessageIds[i] = existingId;
          continue;
        } catch {
          staleMessageIds.push(existingId);
        }
      }

      // Send a single chunk individually to avoid re-chunking
      const title = i === 0 ? '📌 最近摘要\n\n' : '';
      const footer = chunks.length > 1 ? `\n\n-# 第 ${i + 1}/${chunks.length} 部分` : '';
      const text = `${title}${chunks[i]}${footer}`.trim();
      const plan = buildDeliveryPlan({
        sessionId: this.sessionId,
        chatId: this.chatId,
        text,
        files: [],
        mode: 'log',
        policy: {
          textChunkLimit: config.textChunkLimit,
          chunkMode: config.chunkMode,
          replyToMode: config.replyToMode,
          ackReaction: config.ackReaction,
        },
      });
      const createdIds = await deliver(this.channel, plan);
      if (createdIds.length > 0) {
        nextMessageIds[i] = createdIds[0];
      }
    }

    for (const staleId of [...staleMessageIds, ...this.digestMessageIds.slice(chunks.length)]) {
      await this.channel.messages.delete(staleId).catch(() => {});
    }

    this.digestMessageIds = nextMessageIds;
  }

  private buildDigestEmbed(content: string, index: number, total: number): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setDescription(content)
      .setTimestamp();

    if (index === 0) embed.setTitle('📌 最近摘要');
    if (total > 1) {
      embed.setFooter({ text: `第 ${index + 1}/${total} 部分` });
    } else {
      embed.setFooter({ text: `更新于 <t:${Math.floor(Date.now() / 1000)}:R>` });
    }
    return embed;
  }

  private async sendFinalSummaryMessage(
    mode: 'user_reply' | 'summary' | 'system_notice',
    prefix: string,
    content: string,
    replyToMessageId?: string,
    attachments: string[] = [],
  ): Promise<void> {
    const text = `${prefix}${content}`.trim();
    const plan = buildDeliveryPlan({
      sessionId: this.sessionId,
      chatId: this.chatId,
      text,
      files: attachments,
      mode,
      replyToMessageId,
      policy: {
        textChunkLimit: config.textChunkLimit,
        chunkMode: config.chunkMode,
        replyToMode: config.replyToMode,
        ackReaction: config.ackReaction,
      },
    });
    await deliver(this.channel, plan);
  }

  private splitIfNeeded(content: string): string[] {
    if (!content.trim()) return [];
    return chunkText(content, 1900, 'length');
  }
}
