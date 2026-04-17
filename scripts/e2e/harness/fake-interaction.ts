/**
 * Minimal ChatInputCommandInteraction / ButtonInteraction shapes used by
 * E2E scripts. The `channel` field must be a real TextChannel so that
 * handler-side `interaction.reply` / `channel.send` hit real Discord and
 * can be verified by `channel.messages.fetch()`.
 */

import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
  Snowflake,
  TextChannel,
  User,
} from 'discord.js';

export interface FakeInteractionOptions {
  /** Who is "clicking" / running the slash command. Defaults to the bot itself. */
  user?: User;
  member?: GuildMember | null;
  /** Real channel where side effects will land. */
  channel: TextChannel;
  guild: Guild;
}

type StringOption = { name: string; value: string };

/** Build a ChatInputCommandInteraction that handleAgent / handleProject etc. can consume. */
export function makeChatInputInteraction(args: {
  commandName: string;
  subcommand: string;
  stringOptions?: StringOption[];
  env: FakeInteractionOptions;
}): ChatInputCommandInteraction {
  const { commandName, subcommand, stringOptions = [], env } = args;
  const replies: Array<{ content?: string; ephemeral?: boolean; [key: string]: unknown }> = [];

  const optionsBag = {
    getSubcommand: () => subcommand,
    getString: (name: string, required?: boolean) => {
      const opt = stringOptions.find((o) => o.name === name);
      if (!opt && required) throw new Error(`required option "${name}" missing`);
      return opt?.value ?? null;
    },
    getBoolean: () => null,
    getInteger: () => null,
    getNumber: () => null,
    getUser: () => null,
    getMember: () => null,
    getChannel: () => null,
    getRole: () => null,
    getAttachment: () => null,
    getMentionable: () => null,
  };

  const interaction = {
    type: 2, // APPLICATION_COMMAND
    commandName,
    channel: env.channel,
    channelId: env.channel.id,
    guild: env.guild,
    guildId: env.guild.id,
    user: env.user ?? env.guild.client.user,
    member: env.member ?? null,
    options: optionsBag,
    replied: false,
    deferred: false,
    async reply(payload: string | Record<string, unknown>) {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      replies.push(body as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).replied = true;
      return body;
    },
    async editReply(payload: string | Record<string, unknown>) {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      replies.push(body as Record<string, unknown>);
      return body;
    },
    async deferReply() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).deferred = true;
    },
    async followUp(payload: string | Record<string, unknown>) {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      replies.push(body as Record<string, unknown>);
      return body;
    },
    // Harness-only helper — not part of real interaction API
    __replies: replies,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return interaction as any as ChatInputCommandInteraction;
}

export interface FakeButtonInteraction extends ButtonInteraction {
  __replies: Array<Record<string, unknown>>;
}

export function makeButtonInteraction(args: {
  customId: string;
  messageId: Snowflake;
  env: FakeInteractionOptions;
}): FakeButtonInteraction {
  const replies: Array<Record<string, unknown>> = [];
  const interaction = {
    type: 3, // MESSAGE_COMPONENT
    componentType: 2, // BUTTON
    customId: args.customId,
    channel: args.env.channel,
    channelId: args.env.channel.id,
    guild: args.env.guild,
    guildId: args.env.guild.id,
    user: args.env.user ?? args.env.guild.client.user,
    member: args.env.member ?? null,
    message: { id: args.messageId },
    replied: false,
    deferred: false,
    async reply(payload: string | Record<string, unknown>) {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      replies.push(body as Record<string, unknown>);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).replied = true;
      return body;
    },
    async update(payload: Record<string, unknown>) {
      replies.push(payload);
      return payload;
    },
    async deferUpdate() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).deferred = true;
    },
    async followUp(payload: string | Record<string, unknown>) {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      replies.push(body as Record<string, unknown>);
      return body;
    },
    __replies: replies,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return interaction as any as FakeButtonInteraction;
}

export function lastReplyText(
  interaction: ChatInputCommandInteraction | FakeButtonInteraction,
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const replies = (interaction as any).__replies as Array<Record<string, unknown>>;
  if (!replies || replies.length === 0) return '';
  const last = replies[replies.length - 1];
  return typeof last.content === 'string' ? last.content : JSON.stringify(last);
}
