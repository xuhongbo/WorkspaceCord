// 总结处理器：区分本轮总结和结束总结
// 参考设计文档 5.5

import { type TextChannel, type AnyThreadChannel } from 'discord.js';
import { config } from '@workspacecord/core';
import { buildDeliveryPlan } from './delivery-policy.ts';
import { deliver } from './delivery.ts';
import { DigestDelivery } from './digest-delivery.ts';

export class SummaryHandler {
  private sessionId: string;
  private chatId: string;
  private channel: TextChannel | AnyThreadChannel;
  private digestDelivery: DigestDelivery;

  constructor(
    sessionId: string,
    chatId: string,
    channel: TextChannel | AnyThreadChannel,
  ) {
    this.sessionId = sessionId;
    this.chatId = chatId;
    this.channel = channel;
    this.digestDelivery = new DigestDelivery(channel);
  }

  async sendTurnSummary(
    content: string,
    _turn: number,
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
  }

  async sendTurnFailure(
    content: string,
    _turn: number,
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
  }

  async sendEndingSummary(content: string, attachments: string[] = []): Promise<void> {
    await this.sendFinalSummaryMessage(
      'system_notice',
      '🏁 会话结束\n\n',
      content,
      undefined,
      attachments,
    );
  }

  async sendDigestSummary(content: string): Promise<void> {
    await this.digestDelivery.send(content);
  }

  async relocateDigestToBottom(): Promise<{ oldMessageIds: string[]; newMessageIds: string[] }> {
    return await this.digestDelivery.relocateToBottom();
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
}
