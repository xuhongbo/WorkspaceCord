import { ChannelType, type Guild, type TextChannel } from 'discord.js';
import type { Client } from 'discord.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ServiceBus, intervalService, config } from '@workspacecord/core';
import {
  registerOutputPort,
  reconcileAndCollectAutoResumeCandidates,
  executeSessionContinue,
} from '@workspacecord/engine';
import { gateCoordinator } from '@workspacecord/state';
import { DiscordOutputPort } from './discord-output-port.ts';
import { LogBuffer } from './bot-log-buffer.ts';
import { PresenceManager } from './bot-presence.ts';
import { reconcileSessionRecordsWithGuild } from './session-housekeeping.ts';
import { startSync, stopSync } from './session-sync.ts';
import { CodexLogMonitor } from './monitors/codex-log-monitor.ts';
import { handleCodexMonitorStateChange } from './codex-monitor-bridge.ts';
import { startIpcServer, stopIpcServer } from './ipc-server.ts';
import { startHealthMonitor, stopHealthMonitor, setBotStartTime } from './health-monitor.ts';
import { startPerformanceMonitoring, stopPerformanceMonitoring } from './panel-adapter.ts';
import { stopMessageHandler } from './message-handler.ts';
import { runSubagentWatchdog } from './subagent-manager.ts';
import { loadArchived, checkAutoArchive } from './archive-manager.ts';
import { loadProjects } from '@workspacecord/engine/project-manager';
import { loadSessions } from '@workspacecord/engine/session-registry';
import { getSessionView } from '@workspacecord/engine/session-context';
import { registerCommands } from './commands.ts';
import { cleanupOldMessages, notifyUnmanagedCodexHint } from './bot-services-helpers.ts';

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

export class BotServicesOrchestrator {
  #serviceBus = new ServiceBus();

  async setupServices(client: Client): Promise<ServiceContainer> {
    registerOutputPort(new DiscordOutputPort());
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
    // 先让 gate registry 从磁盘加载 gates.json(历史 bug:此前从未调用 ⇒ pending gate 重启后丢)
    await gateCoordinator.init();
    await this.#reconcilePendingGates(client, logBuffer);
    await this.#resumeAbandonedMonitorRuns(client, logBuffer);

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

  /**
   * 重启后对悬挂的 Monitor run 执行 reconcile,并按 config.monitorAutoResumePolicy 续跑符合条件的 session。
   * 续跑采用 fire-and-forget:每个 session 独立异步运行,不阻塞启动。
   */
  async #resumeAbandonedMonitorRuns(client: Client, logBuffer: LogBuffer): Promise<void> {
    let result;
    try {
      result = await reconcileAndCollectAutoResumeCandidates(config.monitorAutoResumePolicy);
    } catch (err) {
      console.error('[MonitorAutoResume] reconcile failed:', err);
      return;
    }

    if (result.abandoned.length > 0) {
      logBuffer.log(
        `Marked ${result.abandoned.length} orphan monitor run(s) as abandoned on startup.`,
      );
    }

    if (result.candidates.length === 0) return;

    logBuffer.log(
      `Auto-resuming ${result.candidates.length} monitor session(s) (policy=${config.monitorAutoResumePolicy}).`,
    );

    for (const candidate of result.candidates) {
      const session = getSessionView(candidate.sessionId);
      if (!session) continue;
      const channel = client.channels.cache.get(candidate.channelId) as TextChannel | undefined;
      if (!channel) {
        console.warn(
          `[MonitorAutoResume] sessionId=${candidate.sessionId} channel ${candidate.channelId} not accessible, skipping`,
        );
        continue;
      }
      console.log(
        `[MonitorAutoResume] resuming sessionId=${candidate.sessionId} runId=${candidate.runId} lastIteration=${candidate.lastIteration}`,
      );
      void executeSessionContinue(session, channel).catch((err: unknown) => {
        console.error(
          `[MonitorAutoResume] sessionId=${candidate.sessionId} resume failed:`,
          err,
        );
      });
    }
  }

  async #reconcilePendingGates(client: Client, logBuffer: LogBuffer): Promise<void> {
    const result = gateCoordinator.reconcileOnStartup(config.gateRestartPolicy);

    // 过期或被策略标灰的:回填 Discord 消息为灰色
    for (const { gateId, discordMessageId } of result.invalidated) {
      if (!discordMessageId) continue;
      const gate = gateCoordinator.getGate(gateId);
      if (!gate?.sessionId) continue;
      const session = getSessionView(gate.sessionId);
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
        console.error(`[GateReconcile] Failed to update message for gate ${gateId}:`, err);
      }
    }

    if (result.resumed.length > 0) {
      logBuffer.log(
        `Resumed ${result.resumed.length} pending gate(s) across restart (policy=resume-pending).`,
      );
    }
    if (result.invalidated.length > 0) {
      logBuffer.log(`Closed ${result.invalidated.length} orphan/overdue gate(s) on startup.`);
    }
  }

  #registerServices(
    client: Client,
    logBuffer: LogBuffer,
    presence: PresenceManager,
  ): void {
    this.#serviceBus.register({ name: 'message-handler', start() { /* started on module load */ }, stop() { stopMessageHandler(); } });
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
        const { registerLocalSession } = await import('./session-local-registration.ts');
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
