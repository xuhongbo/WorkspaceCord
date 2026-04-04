import {
  Client,
  GatewayIntentBits,
  ChannelType,
  InteractionType,
  type TextChannel,
  type Interaction,
  type Message,
} from 'discord.js';
import { config } from './config.ts';
import { BotServicesOrchestrator, type ServiceContainer } from './bot-services-orchestrator.ts';
import { LogBuffer } from './bot-log-buffer.ts';
import { getAllSessions, endSession, getSessionByChannel } from './thread-manager.ts';
import { acquireLock, releaseLock } from './bot-locks.ts';
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

// ─── Module-level singletons (backwards compatibility) ────────────────────────

let logBuffer: LogBuffer | null = null;
let serviceContainer: ServiceContainer | null = null;

export function botLog(msg: string): void {
  if (!logBuffer) {
    const timestamp = new Date().toISOString().slice(11, 19);
    console.log(`[${timestamp}] ${msg}`);
    return;
  }
  logBuffer.log(msg);
}

export async function flushLogs(): Promise<void> {
  await logBuffer?.flush();
}

export async function routeInteractionCreate(interaction: Interaction): Promise<void> {
  try {
    if (interaction.type === InteractionType.ApplicationCommand && interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'project': return await handleProject(interaction);
        case 'agent': return await handleAgent(interaction);
        case 'subagent': return await handleSubagent(interaction);
        case 'shell': return await handleShell(interaction);
        case 'spawn': return await handleSpawnShortcut(interaction);
        case 'stop': return await handleStopShortcut(interaction);
        case 'end': return await handleEndShortcut(interaction);
        case 'run': return await handleRunShortcut(interaction);
      }
    }
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isStringSelectMenu()) return await handleSelectMenu(interaction);
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

// ─── Main entry point ────────────────────────────────────────────────────────

let client: Client;

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

  // Set up event handlers before ready
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
        console.error(`Failed to end session on thread delete: ${err.message}`),
      );
    }
  });

  // Bot ready — delegate to orchestrator
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    const orchestrator = new BotServicesOrchestrator();
    serviceContainer = await orchestrator.setupServices(client);
    logBuffer = serviceContainer.logBuffer;

    const guild = client.guilds.cache.first();
    if (guild) {
      serviceContainer.logChannel =
        (guild.channels.cache.find(
          (ch) => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText && !ch.parentId,
        ) as TextChannel | undefined) ?? serviceContainer.logChannel;
      logBuffer.setChannel(serviceContainer.logChannel);
    }
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
  });

  // Graceful shutdown
  const shutdown = async () => {
    botLog('Shutting down...');
    if (serviceContainer) {
      await serviceContainer.serviceBus.stopAll();
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
