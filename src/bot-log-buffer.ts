import type { TextChannel } from 'discord.js';
import { config } from './config.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { deliver } from './discord/delivery.ts';

export class LogBuffer {
  #buffer: string[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #channel: TextChannel | null = null;

  setChannel(channel: TextChannel | null): void {
    this.#channel = channel;
  }

  log(msg: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    const formatted = `\`[${timestamp}]\` ${msg}`;
    console.log(`[${timestamp}] ${msg}`);
    this.#buffer.push(formatted);
    if (!this.#timer) {
      this.#timer = setTimeout(() => { void this.flush(); }, 2000);
    }
  }

  async flush(): Promise<void> {
    this.#timer = null;
    if (!this.#channel || this.#buffer.length === 0) return;
    const lines = this.#buffer.splice(0, this.#buffer.length);

    try {
      const plan = buildDeliveryPlan({
        sessionId: `bot-log:${this.#channel.id}`,
        chatId: this.#channel.id,
        text: lines.join('\n'),
        files: [],
        mode: 'log',
        policy: {
          textChunkLimit: config.textChunkLimit,
          chunkMode: config.chunkMode,
          replyToMode: config.replyToMode,
          ackReaction: config.ackReaction,
        },
      });
      await deliver(this.#channel, plan);
    } catch {
      // Log channel may have been deleted or bot lost permissions
    }
  }
}
