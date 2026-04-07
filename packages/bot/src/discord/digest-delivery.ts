import { EmbedBuilder, type TextChannel, type AnyThreadChannel } from 'discord.js';
import { chunkText } from './delivery-policy.ts';

type DigestChannel = TextChannel | AnyThreadChannel;

export class DigestDelivery {
  private readonly channel: DigestChannel;
  private messageIds: string[] = [];
  private chunks: string[] = [];

  constructor(channel: DigestChannel) {
    this.channel = channel;
  }

  async send(content: string): Promise<void> {
    const chunks = this.splitIfNeeded(content);
    if (chunks.length === 0) return;

    const nextMessageIds: string[] = [];
    const replacedMessageIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const existingId = this.messageIds[i];
      const embed = this.buildDigestEmbed(chunks[i], i, chunks.length);

      if (existingId) {
        try {
          await this.channel.messages.edit(existingId, {
            content: '',
            embeds: [embed],
          });
          nextMessageIds.push(existingId);
          continue;
        } catch {
          replacedMessageIds.push(existingId);
        }
      }

      const message = await this.channel.send({ embeds: [embed] });
      nextMessageIds.push(message.id);
    }

    for (const staleId of [...replacedMessageIds, ...this.messageIds.slice(chunks.length)]) {
      await this.channel.messages.delete(staleId).catch(() => {});
    }

    this.messageIds = nextMessageIds;
    this.chunks = [...chunks];
  }

  async relocateToBottom(): Promise<{ oldMessageIds: string[]; newMessageIds: string[] }> {
    if (this.messageIds.length === 0 || this.chunks.length === 0) {
      return { oldMessageIds: [], newMessageIds: [] };
    }

    const oldMessageIds = [...this.messageIds];
    const newMessageIds: string[] = [];

    try {
      for (let i = 0; i < this.chunks.length; i++) {
        const embed = this.buildDigestEmbed(this.chunks[i], i, this.chunks.length);
        const message = await this.channel.send({ embeds: [embed] });
        newMessageIds.push(message.id);
      }
    } catch (error) {
      for (const messageId of newMessageIds) {
        await this.channel.messages.delete(messageId).catch(() => {});
      }
      throw error;
    }

    this.messageIds = newMessageIds;
    return { oldMessageIds, newMessageIds };
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

  private splitIfNeeded(content: string): string[] {
    if (!content.trim()) return [];
    return chunkText(content, 1900, 'length');
  }
}
