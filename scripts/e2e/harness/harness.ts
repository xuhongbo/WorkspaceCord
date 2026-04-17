import { randomUUID } from 'node:crypto';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { config } from '../../../packages/core/src/config.ts';
import type { ThreadSession } from '../../../packages/core/src/types.ts';
import {
  createSession as registryCreateSession,
  endSession,
  loadSessions,
} from '../../../packages/engine/src/session-registry.ts';
import {
  loadRegistry,
  getProjectByName,
  getProjectByPath,
  registerProject,
} from '../../../packages/engine/src/project-registry.ts';
import { loadProjects } from '../../../packages/engine/src/project-manager.ts';
import {
  registerOutputPort,
  getOutputPort,
} from '../../../packages/engine/src/output-port.ts';
import { DiscordOutputPort } from '../../../packages/bot/src/discord-output-port.ts';
import { encodeChannelTopic, sweepExpired } from './cleanup-sweeper.ts';
import { snapshotChannels, snapshotStateMachine } from './artifacts.ts';

export interface HarnessBootOptions {
  /** How long a scratch channel lives before `sweepExpired` reclaims it. Default 15 min. */
  ttlMs?: number;
  /** If true, keep scratch channels on dispose (useful for debugging). Default false. */
  keepOnDispose?: boolean;
}

export interface CreateScratchChannelOptions {
  label?: string;
}

export interface CreateSessionOptions {
  channel: TextChannel;
  provider: 'claude' | 'codex';
  mode?: 'auto' | 'plan' | 'normal' | 'monitor';
  agentLabel?: string;
}

export class DiscordE2EHarness {
  readonly runId: string;
  readonly startedAt: Date;
  readonly ttlMs: number;
  readonly bot: Client;
  readonly guild: Guild;
  readonly category: CategoryChannel;
  readonly projectName: string;

  private readonly createdChannelIds = new Set<string>();
  private readonly createdSessionIds = new Set<string>();
  private readonly keepOnDispose: boolean;
  private disposed = false;

  private constructor(init: {
    runId: string;
    startedAt: Date;
    ttlMs: number;
    bot: Client;
    guild: Guild;
    category: CategoryChannel;
    projectName: string;
    keepOnDispose: boolean;
  }) {
    this.runId = init.runId;
    this.startedAt = init.startedAt;
    this.ttlMs = init.ttlMs;
    this.bot = init.bot;
    this.guild = init.guild;
    this.category = init.category;
    this.projectName = init.projectName;
    this.keepOnDispose = init.keepOnDispose;

    const emergencyDispose = () => {
      void this.dispose({ keepOnFail: process.env.E2E_KEEP_ON_FAIL === '1' });
    };
    process.once('SIGINT', emergencyDispose);
    process.once('SIGTERM', emergencyDispose);
    process.once('uncaughtException', emergencyDispose);
  }

  static async boot(opts: HarnessBootOptions = {}): Promise<DiscordE2EHarness> {
    const ttlMs = opts.ttlMs ?? 15 * 60_000;
    const runId = `r${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const startedAt = new Date();

    await loadRegistry();
    await loadProjects();
    await loadSessions();

    const projectName =
      getProjectByPath(process.cwd())?.name ??
      (await registerProject('workspacecord-e2e', process.cwd())).name;
    if (!getProjectByName(projectName)) {
      await registerProject(projectName, process.cwd());
    }

    const bot = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    try {
      registerOutputPort(new DiscordOutputPort());
    } catch {
      /* already registered — harness reuse scenario */
    }
    await bot.login(config.token);

    const guild = await bot.guilds.fetch(config.guildId);
    await guild.channels.fetch();

    const swept = await sweepExpired(guild);
    if (swept > 0) console.log(`[harness] swept ${swept} expired e2e channels/categories`);

    const category = await guild.channels.create({
      name: `wsc-e2e-${runId}`,
      type: ChannelType.GuildCategory,
      reason: 'workspacecord e2e harness',
    });

    return new DiscordE2EHarness({
      runId,
      startedAt,
      ttlMs,
      bot,
      guild,
      category,
      projectName,
      keepOnDispose: opts.keepOnDispose ?? false,
    });
  }

  async createScratchChannel(opts: CreateScratchChannelOptions = {}): Promise<TextChannel> {
    const label = opts.label ?? 'ch';
    const channel = await this.guild.channels.create({
      name: `${label}-${this.runId}`,
      type: ChannelType.GuildText,
      parent: this.category.id,
      topic: encodeChannelTopic(this.runId, this.startedAt.getTime() + this.ttlMs),
      permissionOverwrites: [
        {
          id: this.guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
          allow: [],
        },
      ],
      reason: 'workspacecord e2e scratch channel',
    });
    this.createdChannelIds.add(channel.id);
    return channel;
  }

  async createSession(opts: CreateSessionOptions): Promise<ThreadSession> {
    const session = await registryCreateSession({
      channelId: opts.channel.id,
      categoryId: this.category.id,
      projectName: this.projectName,
      agentLabel: opts.agentLabel ?? `e2e-${opts.provider}`,
      provider: opts.provider,
      directory: process.cwd(),
      type: 'persistent',
      mode: opts.mode ?? 'auto',
      discoverySource: 'discord',
    });
    this.createdSessionIds.add(session.id);
    await getOutputPort().initializePanel(session, opts.channel);
    return session;
  }

  allSessionIds(): string[] {
    return Array.from(this.createdSessionIds);
  }

  allChannelIds(): string[] {
    return Array.from(this.createdChannelIds);
  }

  async snapshotOnFail(label = 'fail'): Promise<void> {
    const channels: TextChannel[] = [];
    for (const id of this.createdChannelIds) {
      const ch = this.guild.channels.cache.get(id);
      if (ch && ch.type === ChannelType.GuildText) channels.push(ch as TextChannel);
    }
    await snapshotChannels(this.runId, label, channels);
    snapshotStateMachine(this.runId, label, this.allSessionIds());
  }

  async dispose(opts: { keepOnFail?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (opts.keepOnFail || this.keepOnDispose) {
      console.log(`[harness] keeping e2e artifacts (category=${this.category.name})`);
      this.bot.destroy();
      return;
    }

    for (const sid of this.createdSessionIds) {
      try {
        endSession(sid);
      } catch {
        /* tolerate */
      }
    }

    for (const channelId of this.createdChannelIds) {
      const ch = this.guild.channels.cache.get(channelId);
      await ch?.delete('wsc-e2e harness dispose').catch(() => {});
    }

    await this.category.delete('wsc-e2e harness dispose').catch(() => {});
    this.bot.destroy();
  }
}
