import type { TextChannel, AnyThreadChannel } from 'discord.js';
import { config } from '../config.ts';
import { buildDeliveryPlan } from '../discord/delivery-policy.ts';
import { deliver } from '../discord/delivery.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

export function detectRepetition(text: string): { isRepetitive: boolean; cleanedText: string } {
  const sentences = text.split(/[。！？\n]+/).filter((s) => s.trim().length > 5);
  if (sentences.length < 3) return { isRepetitive: false, cleanedText: text };

  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    const normalized = sentence.trim();
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  let maxCount = 0;
  let mostRepeated = '';
  for (const [sentence, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostRepeated = sentence;
    }
  }

  if (maxCount >= 5) {
    const parts = text.split(mostRepeated);
    const cleaned = parts.slice(0, 3).join(mostRepeated);
    return {
      isRepetitive: true,
      cleanedText: cleaned + `\n\n⚠️ *[检测到重复输出,已截断 ${maxCount - 2} 次重复]*`,
    };
  }

  return { isRepetitive: false, cleanedText: text };
}

export class MessageStreamer {
  private _channel: SessionChannel;
  private _sessionId: string;
  private currentText = '';
  private transcriptText = '';
  private dirty = false;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly INTERVAL = 400;

  constructor(channel: SessionChannel, sessionId: string) {
    this._channel = channel;
    this._sessionId = sessionId;
  }

  append(text: string, options: { persist?: boolean } = {}): void {
    this.currentText += text;
    if (options.persist !== false) {
      this.transcriptText += text;
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.INTERVAL);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.dirty) return;
    this.flushing = true;
    try {
      this.dirty = false;
      if (this.currentText.trim()) {
        const plan = buildDeliveryPlan({
          sessionId: this._sessionId,
          chatId: this._channel.id,
          text: this.currentText,
          files: [],
          mode: 'progress_update',
          policy: {
            textChunkLimit: config.textChunkLimit,
            chunkMode: config.chunkMode,
            replyToMode: config.replyToMode,
            ackReaction: config.ackReaction,
          },
        });
        await deliver(this._channel, plan);
      }
    } finally {
      this.flushing = false;
      if (this.dirty) this.scheduleFlush();
    }
  }

  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.dirty) {
      this.dirty = false;
      const { cleanedText } = detectRepetition(this.currentText);
      this.currentText = cleanedText;
    }
  }

  async discard(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.currentText = '';
    this.dirty = false;
  }

  getText(): string {
    return this.transcriptText;
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
