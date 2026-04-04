import { ChannelType, type Guild, type TextChannel } from 'discord.js';
import type { Client } from 'discord.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ServiceBus, intervalService } from './core/service-bus.ts';
import { config } from './config.ts';
import { LogBuffer } from './bot-log-buffer.ts';
import { PresenceManager } from './bot-presence.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import { reconcileSessionRecordsWithGuild } from './session-housekeeping.ts';
import { startSync, stopSync } from './session-sync.ts';
import { CodexLogMonitor } from './monitors/codex-log-monitor.ts';
import { handleCodexMonitorStateChange } from './codex-monitor-bridge.ts';
import { startIpcServer, stopIpcServer } from './ipc-server.ts';
import { startHealthMonitor, stopHealthMonitor, setBotStartTime } from './health-monitor.ts';
import { startPerformanceMonitoring, stopPerformanceMonitoring } from './panel-adapter.ts';
import { runSubagentWatchdog } from './subagent-manager.ts';
import { loadArchived, checkAutoArchive } from './archive-manager.ts';
import { loadProjects } from './project-manager.ts';
import { loadSessions, getSession, getAllSessions } from './thread-manager.ts';
import { registerCommands } from './commands.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { deliver } from './discord/delivery.ts';

export interface ServiceContainer {
  serviceBus: ServiceBus;
  logBuffer: LogBuffer;
  presenceManager: PresenceManager;
  logChannel: TextChannel | null;
  codexMonitor: CodexLogMonitor | null;
}

async function findOrCreateLogChannel(guild: Guild): Promise<TextChannel | null> {
  const existing = guild.channels.cache.find(
    (ch) => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText && !ch.parentId,
  ) as TextChannel | undefined;
  if (existing) return existing;
  try {
    return await guild.channels.create({
      name: 'bot-logs',
      type: ChannelType.GuildText,
      reason: 'Auto-created by workspacecord for bot logs',
    });
  } catch {
    console.warn('Could not create #bot-logs channel');
    return null;
  }
}

const unmanagedCodexHintedSessions = new Set<string>();

async function cleanupOldMessages(client: Client): Promise<void> {
  if (!config.messageRetentionDays) return;
  const cutoff = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;
  for (const session of getAllSessions()) {
    if (session.type !== 'persistent') continue;
    try {
      const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (!channel) continue;
      const messages = await channel.messages.fetch({ limit: 100 });
      const old = messages.filter((m) => m.createdTimestamp < cutoff);
      if (old.size > 0) {
        await channel.bulkDelete(old, true);
      }
    } catch {
      /* channel may not exist */
    }
  }
}

async function notifyUnmanagedCodexHint(client: Client, sessionId: string, channelId: string): Promise<void> {
  if (unmanagedCodexHintedSessions.has(sessionId)) return;
  unmanagedCodexHintedSessions.add(sessionId);

  try {
    const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) {
      console.warn(`[Codex Hint] Channel ${channelId} not found, skipping unmanaged hint for session ${sessionId}`);
      return;
    }
    const plan = buildDeliveryPlan({
      sessionId,
      chatId: channelId,
      text: [
        '💡 提示：此会话为非受管模式，仅支持状态监控',
        '如需远程审批能力，请使用 `workspacecord codex` 命令启动会话',
      ].join('\n'),
      files: [],
      mode: 'system_notice',
      policy: {
        textChunkLimit: config.textChunkLimit,
        chunkMode: config.chunkMode,
        replyToMode: config.replyToMode,
        ackReaction: config.ackReaction,
      },
    });
    await deliver(channel, plan);
  } catch (err) {
    console.warn('[Codex Hint] 发送非受管提示失败:', err);
  }
}

export class BotServicesOrchestrator {
  #serviceBus = new ServiceBus();

  async setupServices(client: Client): Promise<ServiceContainer> {
    await registerCommands();
    await loadProjects();
    await loadSessions();
    await loadArchived();

    const guild = client.guilds.cache.first();
    const logChannel = guild ? await findOrCreateLogChannel(guild) : null;
    const logBuffer = new LogBuffer();
    logBuffer.setChannel(logChannel);

    const reconciled = guild ? await reconcileSessionRecordsWithGuild(guild) : null;
    if (reconciled?.endedMissingSessions) {
      logBuffer.log(`Reconciled ${reconciled.endedMissingSessions} stale session record(s) on startup.`);
    }

    setBotStartTime(Date.now());
    await this.#invalidatePendingGates(client);

    if (config.messageRetentionDays) {
      await cleanupOldMessages(client);
    }

    const presenceManager = new PresenceManager(client);
    this.#registerServices(client, logBuffer, presenceManager);
    await this.#serviceBus.startAll();

    logBuffer.log(`Bot online. ${config.dataDir} ready.`);
    logBuffer.log('Codex log monitor started');

    return { serviceBus: this.#serviceBus, logBuffer, presenceManager, logChannel, codexMonitor: null };
  }

  async #invalidatePendingGates(client: Client): Promise<void> {
    const invalidated = gateCoordinator.invalidateAllOnRestart();
    if (!invalidated.length) return;
    console.log(`[GateInvalidation] Invalidating ${invalidated.length} pending gates on restart`);

    for (const { gateId, discordMessageId } of invalidated) {
      if (!discordMessageId) continue;

      const gate = gateCoordinator.getGate(gateId);
      if (!gate?.sessionId) continue;

      const session = getSession(gate.sessionId);
      if (!session) continue;

      const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (!channel?.messages) continue;

      try {
        const message = await channel.messages.fetch(discordMessageId);
        await message.edit({
          components: [],
          embeds: message.embeds.map((e) => ({
            ...e,
            color: 0x808080,
            footer: {
              text: '⚠️ 守护进程已重启，此审批已失效 - 请在终端直接处理，或重新触发操作',
            },
          })),
        });
      } catch (err) {
        console.error(`[GateInvalidation] Failed to update message for gate ${gateId}:`, err);
      }
    }

    console.log(`[GateInvalidation] ${invalidated.length} gates invalidated`);
  }

  #registerServices(
    client: Client,
    logBuffer: LogBuffer,
    presence: PresenceManager,
  ): void {
    this.#serviceBus.register({ name: 'session-sync', start() { startSync(client); }, stop() { stopSync(); } });

    const codexBaseDir = join(homedir(), '.codex', 'sessions');
    const codexMonitor = new CodexLogMonitor(
      codexBaseDir,
      (sessionId, state, event, extra) => {
        void handleCodexMonitorStateChange(
          (cid) => client.channels.cache.get(cid), sessionId, state, event, extra,
        );
      },
      async (providerSessionId, cwd, remoteHumanControl, subagent) => {
        const { registerLocalSession } = await import('./thread-manager.ts');
        const g = client.guilds.cache.first();
        if (!g) return false;
        const result = await registerLocalSession(
          { provider: 'codex', providerSessionId, cwd, discoverySource: 'codex-log',
            labelHint: providerSessionId.slice(0, 12), remoteHumanControl, subagent }, g);

        if (result?.isNewlyCreated && result.session.remoteHumanControl === false) {
          void notifyUnmanagedCodexHint(client, result.session.id, result.session.channelId);
        }

        return result !== null;
      },
    );
    this.#serviceBus.register({
      name: 'codex-log-monitor',
      start() { codexMonitor.start(); },
      stop() { codexMonitor.stop(); },
    });

    this.#serviceBus.register({ name: 'ipc-server', start() { startIpcServer(client); }, stop() { stopIpcServer(); } });
    if (config.healthReportEnabled) {
      this.#serviceBus.register({ name: 'health-monitor', start() { startHealthMonitor(client, (m) => logBuffer.log(m)); }, stop() { stopHealthMonitor(); } });
    }
    this.#serviceBus.register({ name: 'performance-monitoring', start() { startPerformanceMonitoring(); }, stop() { stopPerformanceMonitoring(); } });
    this.#serviceBus.register(intervalService('gate-housekeeping', () => {
      const expired = gateCoordinator.cleanupExpired();
      const archived = gateCoordinator.archiveResolved(100);
      if (expired || archived) console.log(`[GateHousekeeping] expired=${expired}, archived=${archived}`);
    }, 60_000));
    this.#serviceBus.register(intervalService('presence', () => presence.updatePresence(), 30_000));
    this.#serviceBus.register(intervalService('subagent-watchdog', () => {
      runSubagentWatchdog((tid) => {
        const ch = client.channels.cache.get(tid);
        return ch?.isThread() ? ch : undefined;
      }).catch((err) => console.error(`Subagent watchdog error: ${err.message}`));
    }, 5 * 60 * 1000));
    if (config.autoArchiveDays || config.maxActiveSessionsPerProject) {
      const g = client.guilds.cache.first();
      if (g) {
        this.#serviceBus.register(intervalService('auto-archive', () => {
          checkAutoArchive(g).catch((err) => console.error(`Auto-archive check error: ${err.message}`));
        }, 60 * 60 * 1000));
      }
    }
    if (config.messageRetentionDays) {
      this.#serviceBus.register(intervalService('message-retention', () => {
        cleanupOldMessages(client).catch((err) => console.error(`Message retention error: ${err.message}`));
      }, 60 * 60 * 1000));
    }
  }
}
