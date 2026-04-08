import { vi } from 'vitest';
import { ChannelType } from 'discord.js';

export function makeTextChannel(overrides: {
  id?: string;
  parentId?: string | null;
  name?: string;
  send?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    id: overrides.id ?? 'channel-1',
    parentId: overrides.parentId ?? null,
    name: overrides.name ?? 'test-channel',
    type: ChannelType.GuildText,
    isThread: () => false,
    send: overrides.send ?? vi.fn(async () => undefined),
    delete: overrides.delete ?? vi.fn(async () => undefined),
  };
}

export function makeThreadChannel(overrides: {
  id?: string;
  parent?: ReturnType<typeof makeTextChannel>;
} = {}) {
  const parent = overrides.parent ?? makeTextChannel();
  return {
    id: overrides.id ?? 'thread-1',
    parentId: parent.id,
    parent,
    type: ChannelType.PublicThread,
    isThread: () => true,
    send: vi.fn(async () => undefined),
  };
}

export function makeGuild(overrides: {
  channels?: Array<{ id: string; name?: string; parentId?: string | null; [key: string]: unknown }>;
  createImpl?: (payload: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const channelMap = new Map<string, unknown>();
  for (const ch of overrides.channels ?? []) {
    channelMap.set(ch.id, ch);
  }

  return {
    id: 'guild-1',
    channels: {
      cache: {
        get: vi.fn((id: string) => channelMap.get(id)),
        find: vi.fn((predicate: (ch: unknown) => boolean) => {
          for (const ch of channelMap.values()) {
            if (predicate(ch)) return ch;
          }
          return undefined;
        }),
      },
      create: overrides.createImpl
        ? vi.fn(overrides.createImpl)
        : vi.fn(async () => ({ id: 'created-channel' })),
    },
  };
}

export function makeInteraction(args: {
  subcommand?: string;
  values?: Record<string, string | number | null | undefined>;
  channel?: ReturnType<typeof makeTextChannel> | ReturnType<typeof makeThreadChannel>;
  guild?: ReturnType<typeof makeGuild>;
} = {}) {
  const channel = args.channel ?? makeTextChannel();
  const guild = args.guild ?? makeGuild();
  const values = args.values ?? {};

  const reply = vi.fn(async (payload: unknown) => payload);
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async (payload: unknown) => payload);

  return {
    user: { id: 'user-1', tag: 'tester#0001' },
    guild,
    channel,
    channelId: channel.id,
    options: {
      getSubcommand: () => args.subcommand ?? 'unknown',
      getString: (name: string, _required = false) => {
        const value = values[name];
        return value !== undefined ? String(value) : null;
      },
      getInteger: (name: string, _required = false) => {
        const value = values[name];
        return value !== undefined && value !== null ? Number(value) : null;
      },
    },
    reply,
    deferReply,
    editReply,
  };
}
