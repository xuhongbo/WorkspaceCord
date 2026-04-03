import {
  Client,
  GatewayIntentBits,
  ActivityType,
  InteractionType,
  ChannelType,
  type TextChannel,
  type Interaction,
  type Message,
} from 'discord.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { registerCommands } from './commands.ts';
import {
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  handleSpawnShortcut,
  handleStopShortcut,
  handleEndShortcut,
  handleRunShortcut,
  setLogger,
} from './command-handlers.ts';
import { handleMessage } from './message-handler.ts';
import { handleButton, handleSelectMenu } from './button-handler.ts';
import {
  loadSessions,
  getAllSessions,
  endSession,
  getSessionByChannel,
} from './thread-manager.ts';
import { loadProjects } from './project-manager.ts';
import { CodexLogMonitor } from './monitors/codex-log-monitor.ts';
import { handleCodexMonitorStateChange } from './codex-monitor-bridge.ts';
import { startHookServer, stopHookServer } from './hook-server.ts';
import { startHookWatcher, stopHookWatcher } from './hook-watcher.ts';
import {
  checkHookHealth,
  logHookHealthStatus,
  sendHookHealthNotification,
} from './hook-health-check.ts';
import { homedir } from 'node:os';
import { runSubagentWatchdog } from './subagent-manager.ts';
import { loadArchived, checkAutoArchive } from './archive-manager.ts';
import { startSync, stopSync } from './session-sync.ts';
import { startHealthMonitor, stopHealthMonitor, setBotStartTime } from './health-monitor.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import { reconcileSessionRecordsWithGuild } from './session-housekeeping.ts';
import { startPerformanceMonitoring, stopPerformanceMonitoring } from './panel-adapter.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { deliver } from './discord/delivery.ts';
import { ServiceContainer, intervalService } from './service-container.ts';

let client: Client;
let logChannel: TextChannel | null = null;
let codexMonitor: CodexLogMonitor | null = null;
const unmanagedCodexHintedSessions = new Set<string>();
const logBuffer: string[] = [];
let logTimer: ReturnType<typeof setTimeout> | null = null;

let serviceContainer: ServiceContainer | null = null;

export async function routeInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    if (
      interaction.type === InteractionType.ApplicationCommand &&
      interaction.isChatInputCommand()
    ) {
      switch (interaction.commandName) {
        case 'project':
          return await handleProject(interaction as never);
        case 'agent':
          return await handleAgent(interaction as never);
        case 'subagent':
          return await handleSubagent(interaction as never);
        case 'shell':
          return await handleShell(interaction as never);
        case 'spawn':
          return await handleSpawnShortcut(interaction as never);
        case 'stop':
          return await handleStopShortcut(interaction as never);
        case 'end':
          return await handleEndShortcut(interaction as never);
        case 'run':
          return await handleRunShortcut(interaction as never);
      }
    }

    if (interaction.isButton()) {
      return await handleButton(interaction as never);
    }

    if (interaction.isStringSelectMenu()) {
      return await handleSelectMenu(interaction as never);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'An error occurred.', ephemeral: true });
      }
    } catch {
      /* can't recover */
    }
  }
}

export async function routeMessageCreate(message: Message): Promise<void> {
  await handleMessage(message);
}

// ─── Process lock ─────────────────────────────────────────────────────────────

const LOCK_FILE = join(config.dataDir, 'bot.lock');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (!Number.isNaN(pid) && isProcessRunning(pid)) {
        console.error(`[bot] Another instance is already running (PID ${pid}). Exiting.`);
        return false;
      }
    } catch {
      /* stale lock file */
    }
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
  writeFileSync(LOCK_FILE, process.pid.toString(), 'utf-8');
  return true;
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (pid === process.pid) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    /* ignore */
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

export function botLog(msg: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  const formatted = `\`[${timestamp}]\` ${msg}`;
  console.log(`[${timestamp}] ${msg}`);

  logBuffer.push(formatted);
  if (!logTimer) {
    logTimer = setTimeout(flushLogs, 2000);
  }
}

export async function flushLogs(): Promise<void> {
  logTimer = null;
  if (!logChannel || logBuffer.length === 0) return;
  const lines = logBuffer.splice(0, logBuffer.length);

  try {
    const plan = buildDeliveryPlan({
      sessionId: `bot-log:${logChannel.id}`,
      chatId: logChannel.id,
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
    await deliver(logChannel, plan);
  } catch {
    // Log channel may have been deleted or bot lost permissions
  }
}

/**
 * 重启时失效所有待处理门控
 * 参考设计文档 11.5.1 节
 */
async function invalidatePendingGatesOnRestart(client: Client): Promise<void> {
  const invalidated = gateCoordinator.invalidateAllOnRestart();

  if (invalidated.length === 0) {
    return;
  }

  console.log(`[GateInvalidation] Invalidating ${invalidated.length} pending gates on restart`);

  for (const { gateId, discordMessageId } of invalidated) {
    if (!discordMessageId) continue;

    const gate = gateCoordinator.getGate(gateId);
    if (!gate) continue;

    try {
      const session = getAllSessions().find(s => s.id === gate.sessionId);
      if (!session) continue;

      const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (!channel) continue;

      const message = await channel.messages.fetch(discordMessageId);
      if (!message) continue;

      await message.edit({
        components: [],
        embeds: message.embeds.map((e) => ({
          ...e,
          color: 0x808080,
          footer: {
            text: '⚠️ 守护进程已重启，此审批已失效 - 请在终端直接处理，或重新触发操作'
          },
        })),
      });

      console.log(`[GateInvalidation] Updated Discord message for gate ${gateId}`);
    } catch (err) {
      console.error(`[GateInvalidation] Failed to update message for gate ${gateId}:`, err);
    }
  }

  botLog(`重启时失效了 ${invalidated.length} 个待处理门控`);
}

function updatePresence(): void {
  const all = getAllSessions();
  const generating = all.filter((s) => s.isGenerating).length;

  if (all.length === 0) {
    client.user?.setPresence({
      status: 'idle',
      activities: [{ name: 'No active agents', type: ActivityType.Custom }],
    });
  } else {
    const label = generating > 0 ? `${generating} generating` : `${all.length} agents`;
    client.user?.setPresence({
      status: 'online',
      activities: [{ name: label, type: ActivityType.Watching }],
    });
  }
}

async function cleanupOldMessages(): Promise<void> {
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

async function notifyUnmanagedCodexHint(session: { id: string; channelId: string }): Promise<void> {
  if (unmanagedCodexHintedSessions.has(session.id)) return;
  unmanagedCodexHintedSessions.add(session.id);

  const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
  if (!channel) return;

  try {
    const plan = buildDeliveryPlan({
      sessionId: session.id,
      chatId: session.channelId,
      text: [
        '💡 提示：此 Codex 会话为非受管模式，仅支持状态监控',
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

export async function startBot(): Promise<void> {
  if (!acquireLock()) {
    process.exit(1);
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
  });

  setLogger(botLog);

  client.on('interactionCreate', routeInteractionCreate);
  client.on('messageCreate', routeMessageCreate);

  client.on('channelDelete', (channel) => {
    const session = getSessionByChannel(channel.id);
    if (session && session.type === 'persistent') {
      endSession(session.id).catch((err) =>
        console.error(`Failed to end session on channel delete: ${err.message}`),
      );
    }
  });

  client.on('threadDelete', (thread) => {
    const session = getSessionByChannel(thread.id);
    if (session && session.type === 'subagent') {
      endSession(session.id).catch((err) =>
        console.error(`Failed to end subagent session on thread delete: ${err.message}`),
      );
    }
  });

  // Bot ready
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    await registerCommands();
    await loadProjects();
    await loadSessions();
    await loadArchived();

    // Find or create #bot-logs channel
    const guild = client.guilds.cache.first();
    if (guild) {
      logChannel =
        (guild.channels.cache.find(
          (ch) => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText && !ch.parentId,
        ) as TextChannel | undefined) ?? null;

      if (!logChannel) {
        try {
          logChannel = await guild.channels.create({
            name: 'bot-logs',
            type: ChannelType.GuildText,
            reason: 'Auto-created by workspacecord for bot logs',
          });
        } catch {
          console.warn('Could not create #bot-logs channel');
        }
      }
    }

    const reconciled = guild ? await reconcileSessionRecordsWithGuild(guild) : null;
    if (reconciled && reconciled.endedMissingSessions > 0) {
      botLog(`Reconciled ${reconciled.endedMissingSessions} stale session record(s) on startup.`);
    }

    botLog(`Bot online. ${getAllSessions().length} session(s) restored.`);
    updatePresence();
    setBotStartTime(Date.now());

    await invalidatePendingGatesOnRestart(client);

    // ─── Register services ─────────────────────────────────────────────
    serviceContainer = new ServiceContainer();

    // Session sync
    serviceContainer.register({
      name: 'session-sync',
      start() { startSync(client); },
      stop() { stopSync(); },
    });

    // Codex log monitor
    const codexBaseDir = join(homedir(), '.codex', 'sessions');
    codexMonitor = new CodexLogMonitor(
      codexBaseDir,
      (sessionId, state, event, extra) => {
        void handleCodexMonitorStateChange(
          (channelId) => client.channels.cache.get(channelId),
          sessionId,
          state,
          event,
          extra,
        );
      },
      async (providerSessionId, cwd, remoteHumanControl, subagent) => {
        const { registerLocalSession } = await import('./thread-manager.ts');
        const g = client.guilds.cache.first();
        if (!g) return false;

        const result = await registerLocalSession(
          {
            provider: 'codex',
            providerSessionId,
            cwd,
            discoverySource: 'codex-log',
            labelHint: providerSessionId.slice(0, 12),
            remoteHumanControl,
            subagent,
          },
          g,
        );

        if (result?.isNewlyCreated && result.session.remoteHumanControl === false) {
          notifyUnmanagedCodexHint({
            id: result.session.id,
            channelId: result.session.channelId,
          }).catch((err) =>
            console.error(`Failed to send unmanaged Codex hint for session ${result.session.id}: ${err.message}`),
          );
        }

        return result !== null;
      },
    );
    serviceContainer.register({
      name: 'codex-log-monitor',
      start() { codexMonitor!.start(); },
      stop() { codexMonitor?.stop(); codexMonitor = null; },
    });

    // Hook server
    serviceContainer.register({
      name: 'hook-server',
      start() { startHookServer(client); },
      stop() { stopHookServer(); },
    });

    // Hook watcher
    serviceContainer.register({
      name: 'hook-watcher',
      start() { startHookWatcher(client); },
      stop() { stopHookWatcher(); },
    });

    // Health monitor
    if (config.healthReportEnabled) {
      serviceContainer.register({
        name: 'health-monitor',
        start() { startHealthMonitor(client, botLog); },
        stop() { stopHealthMonitor(); },
      });
    }

    // Performance monitoring
    serviceContainer.register({
      name: 'performance-monitoring',
      start() { startPerformanceMonitoring(); },
      stop() { stopPerformanceMonitoring(); },
    });

    // Gate housekeeping
    serviceContainer.register(intervalService(
      'gate-housekeeping',
      () => {
        const expired = gateCoordinator.cleanupExpired();
        const archived = gateCoordinator.archiveResolved(100);
        if (expired > 0 || archived > 0) {
          console.log(`[GateHousekeeping] expired=${expired}, archived=${archived}`);
        }
      },
      60_000,
    ));

    // Presence update
    serviceContainer.register(intervalService('presence', updatePresence, 30_000));

    // Subagent watchdog
    serviceContainer.register(intervalService(
      'subagent-watchdog',
      () => {
        runSubagentWatchdog((threadId) => {
          const ch = client.channels.cache.get(threadId);
          return ch?.isThread() ? ch : undefined;
        }).catch((err) => console.error(`Subagent watchdog error: ${err.message}`));
      },
      5 * 60 * 1000,
    ));

    // Auto-archive
    if (config.autoArchiveDays || config.maxActiveSessionsPerProject) {
      const g = client.guilds.cache.first();
      if (g) {
        serviceContainer.register(intervalService(
          'auto-archive',
          () => {
            checkAutoArchive(g).catch((err) =>
              console.error(`Auto-archive check error: ${err.message}`),
            );
          },
          60 * 60 * 1000,
        ));
      }
    }

    // Message cleanup
    if (config.messageRetentionDays) {
      await cleanupOldMessages();
      serviceContainer.register(intervalService(
        'message-cleanup',
        () => { void cleanupOldMessages(); },
        60 * 60 * 1000,
      ));
    }

    // Start all services
    await serviceContainer.startAll();

    // One-shot: hook health notification
    const hookHealth = checkHookHealth();
    logHookHealthStatus(hookHealth);
    if (!hookHealth.isHealthy || hookHealth.warnings.length > 0) {
      await sendHookHealthNotification(client, hookHealth, logChannel?.id);
    }

    // Periodic hook health re-check (every 30 minutes)
    let previousHealthStatus = hookHealth.isHealthy;
    serviceContainer.register(intervalService(
      'hook-health-recheck',
      () => {
        const currentHealth = checkHookHealth();
        if (currentHealth.isHealthy !== previousHealthStatus) {
          const direction = currentHealth.isHealthy ? 'recovered' : 'degraded';
          console.log(`[Hook Health Re-check] Status changed: ${direction}`);
          botLog(`Claude 钩子健康状态变化: ${direction === 'recovered' ? '已恢复' : '异常'}`);
          if (!currentHealth.isHealthy || currentHealth.warnings.length > 0) {
            sendHookHealthNotification(client, currentHealth, logChannel?.id).catch(
              (err) => console.error('[Hook Health Re-check] Notification failed:', err),
            );
          }
          previousHealthStatus = currentHealth.isHealthy;
        }
      },
      30 * 60 * 1000,
    ));

    botLog('Codex log monitor started');
    botLog('Hook server started');
    botLog('Hook watcher started');
  });

  // Discord connection error handlers
  client.on('error', (err) => {
    botLog(`Discord client error: ${err.message}`);
    console.error('Discord client error:', err);
  });

  client.on('warn', (msg) => {
    console.warn('Discord warn:', msg);
  });

  client.on('shardError', (err, shardId) => {
    botLog(`WebSocket error on shard ${shardId}: ${err.message}`);
    console.error(`Shard ${shardId} error:`, err);
  });

  client.on('shardDisconnect', (event, shardId) => {
    botLog(
      `Shard ${shardId} disconnected (code ${event.code}). discord.js will attempt reconnect.`,
    );
    console.warn(`Shard ${shardId} disconnected:`, event);
  });

  client.on('shardReconnecting', (shardId) => {
    console.log(`Shard ${shardId} reconnecting...`);
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    botLog(`Shard ${shardId} resumed (${replayedEvents} events replayed).`);
    const g = client.guilds.cache.first();
    if (g) {
      logChannel =
        (g.channels.cache.find(
          (ch) => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText && !ch.parentId,
        ) as TextChannel | undefined) ?? logChannel;
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    botLog('Shutting down...');
    if (serviceContainer) {
      await serviceContainer.stopAll();
      serviceContainer = null;
    }
    await flushLogs();
    releaseLock();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown().catch(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown().catch(() => process.exit(0));
  });

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    botLog(`Uncaught exception: ${err.message} — restarting`);
    await flushLogs();
    releaseLock();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('Unhandled rejection:', reason);
    botLog(`Unhandled rejection: ${msg}`);
  });

  await client.login(config.token);
}
