import type { Message, TextChannel } from 'discord.js';

export class E2EAssertionError extends Error {}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  // Default raised to 15s: Discord REST latency from some networks commonly
  // hits 1-2s per request, and we poll every 300ms with 500ms debounce in the
  // panel renderer. 10s was too tight on slow links.
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 300;
  const label = opts.label ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value as T;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new E2EAssertionError(
    `timed out waiting for ${label} after ${timeoutMs}ms${
      lastError ? ` (last error: ${(lastError as Error).message})` : ''
    }`,
  );
}

export async function fetchAllMessagesSince(
  channel: TextChannel,
  since: Date,
  limit = 50,
): Promise<Message[]> {
  const collected = await channel.messages.fetch({ limit });
  return Array.from(collected.values())
    .filter((m) => m.createdAt >= since)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export async function waitForMessageMatching(
  channel: TextChannel,
  predicate: (msg: Message) => boolean,
  opts: { since?: Date; timeoutMs?: number; label?: string } = {},
): Promise<Message> {
  const since = opts.since ?? new Date(Date.now() - 30_000);
  return waitFor(
    async () => {
      const messages = await fetchAllMessagesSince(channel, since);
      return messages.find(predicate) ?? null;
    },
    { timeoutMs: opts.timeoutMs, label: opts.label ?? 'message match' },
  );
}

export async function waitForEmbedField(
  fetchMessage: () => Promise<Message | null | undefined>,
  fieldName: string | RegExp,
  valueMatcher: string | RegExp,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  await waitFor(
    async () => {
      const msg = await fetchMessage();
      if (!msg) return null;
      const embed = msg.embeds[0];
      if (!embed) return null;
      const field = embed.fields.find((f) =>
        typeof fieldName === 'string' ? f.name === fieldName : fieldName.test(f.name),
      );
      if (!field) return null;
      if (typeof valueMatcher === 'string') {
        if (!field.value.includes(valueMatcher)) return null;
      } else {
        if (!valueMatcher.test(field.value)) return null;
      }
      return true;
    },
    { timeoutMs: opts.timeoutMs, label: opts.label ?? `embed field ${fieldName}` },
  );
}

export async function waitForEmbedFieldAbsent(
  fetchMessage: () => Promise<Message | null | undefined>,
  fieldName: string | RegExp,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  await waitFor(
    async () => {
      const msg = await fetchMessage();
      if (!msg) return null;
      const embed = msg.embeds[0];
      if (!embed) return true;
      const found = embed.fields.find((f) =>
        typeof fieldName === 'string' ? f.name === fieldName : fieldName.test(f.name),
      );
      return found ? null : true;
    },
    { timeoutMs: opts.timeoutMs, label: opts.label ?? `embed field absent ${fieldName}` },
  );
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new E2EAssertionError(message);
}
