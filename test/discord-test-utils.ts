import { vi } from 'vitest';
import { ChannelType } from 'discord.js';

type OptionValues = Record<string, string | number | null | undefined>;

function makeCache<T extends { id: string; name?: string }>(items: T[] = []) {
  const map = new Map(items.map((item) => [item.id, item]));
  return {
    get: vi.fn((id: string) => map.get(id)),
    find: vi.fn((predicate: (item: T) => boolean) => {
      for (const item of map.values()) {
        if (predicate(item)) return item;
      }
      return undefined;
    }),
    set(item: T) {
      map.set(item.id, item);
    },
    values: () => map.values(),
  };
}

export function makeTextChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-1',
    name: 'channel',
    parentId: 'cat-1',
    type: ChannelType.GuildText,
    topic: null,
    isThread: () => false,
    isTextBased: () => true,
    send: vi.fn(async (payload) => payload),
    delete: vi.fn(async () => undefined),
    messages: { fetch: vi.fn(async () => new Map()) },
    ...overrides,
  };
}

export function makeThreadChannel(overrides: Record<string, unknown> = {}) {
  const parent = (overrides.parent as Record<string, unknown> | undefined) ?? makeTextChannel();
  return {
    id: 'thread-1',
    name: 'thread',
    parent,
    parentId: parent.id,
    type: ChannelType.PublicThread,
    isThread: () => true,
    isTextBased: () => true,
    send: vi.fn(async (payload) => payload),
    setArchived: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function makeGuild(options: {
  channels?: Array<Record<string, unknown>>;
  createImpl?: (payload: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const cache = makeCache(options.channels as Array<{ id: string; name?: string }> | undefined);
  return {
    id: 'guild-1',
    name: 'Guild',
    channels: {
      cache,
      create: vi.fn(async (payload: Record<string, unknown>) => {
        if (options.createImpl) return options.createImpl(payload);
        const created = makeTextChannel({
          id: `created-${Math.random().toString(16).slice(2, 8)}`,
          name: payload.name,
          parentId: payload.parent,
          type: payload.type ?? ChannelType.GuildText,
          topic: payload.topic ?? null,
        });
        cache.set(created);
        return created;
      }),
      fetch: vi.fn(async (id?: string) => (id ? cache.get(id) : undefined)),
    },
  };
}

export function makeOptions(subcommand: string, values: OptionValues = {}) {
  return {
    getSubcommand: () => subcommand,
    getString: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required option: ${name}`);
      }
      return value == null ? null : String(value);
    },
    getInteger: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required integer option: ${name}`);
      }
      return value == null ? null : Number(value);
    },
  };
}

export function makeInteraction(args: {
  subcommand: string;
  values?: OptionValues;
  channel?: Record<string, unknown>;
  guild?: Record<string, unknown>;
  user?: Record<string, unknown>;
}) {
  let lastReply: unknown;
  const reply = vi.fn(async (payload) => {
    lastReply = payload;
    return payload;
  });
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async (payload) => {
    lastReply = payload;
    return payload;
  });
  return {
    user: { id: 'user-1', tag: 'tester#0001', ...args.user },
    guild: args.guild,
    channel: args.channel,
    channelId: String(args.channel?.id ?? 'channel-1'),
    replied: false,
    deferred: false,
    options: makeOptions(args.subcommand, args.values),
    reply,
    deferReply,
    editReply,
    fetchReply: vi.fn(async () => lastReply),
  };
}
