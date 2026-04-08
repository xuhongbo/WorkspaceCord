import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type Interaction,
  type Message,
} from 'discord.js';
import { config } from '@workspacecord/core';
import { BotServicesOrchestrator, type ServiceContainer } from './bot-services-orchestrator.ts';
import { LogBuffer } from './bot-log-buffer.ts';
import { endSession, getSessionByChannel } from '@workspacecord/engine/session-registry';
import { acquireLock, releaseLock } from '@workspacecord/engine/bot-locks';
import {
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  setLogger,
} from './command-handlers.ts';
import { handleMessage } from './message-handler.ts';
import { handleButton, handleSelectMenu } from './button-handler.ts';
import { BotEventRouter } from './bot-event-router.ts';

let logBuffer: LogBuffer | null = null;
let serviceContainer: ServiceContainer | null = null;
let client: Client;

const eventRouter = new BotEventRouter({
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  handleButton,
  handleSelectMenu,
  handleMessage,
});

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
  await eventRouter.routeInteraction(interaction);
}

export async function routeMessageCreate(message: Message): Promise<void> {
  await eventRouter.routeMessage(message);
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
        console.error(`Failed to end session on thread delete: ${err.message}`),
      );
    }
  });

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
    botLog(`Shard ${shardId} disconnected (code ${event.code}). discord.js will attempt reconnect.`);
    console.warn(`Shard ${shardId} disconnected:`, event);
  });

  client.on('shardReconnecting', (shardId) => {
    console.log(`Shard ${shardId} reconnecting...`);
  });

  client.on('shardResume', (shardId, replayedEvents) => {
    botLog(`Shard ${shardId} resumed (${replayedEvents} events replayed).`);
  });

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
