import { createServer, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import type { Client, TextChannel } from 'discord.js';
import type { SessionChannel } from './types.ts';
import { config } from './config.ts';
import { updateSessionState } from './panel-adapter.ts';
import * as sessions from './thread-manager.ts';
import { discoverAndRegisterSession } from './session-discovery.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';
import type { PlatformEvent } from './state/types.ts';

let server: ReturnType<typeof createServer> | null = null;
let discordClient: Client | null = null;
let activeSocketPath: string | null = null;

function isSessionChannel(channel: unknown): channel is SessionChannel {
  if (!channel || typeof channel !== 'object') return false;
  const obj = channel as Record<string, unknown>;
  return 'id' in obj && 'send' in obj && 'messages' in obj;
}

interface IpcMessage {
  type: 'hook-event' | 'gate-resolved';
  payload: Record<string, unknown>;
  secret?: string;
}

export function startIpcServer(client: Client): void {
  discordClient = client;
  const socketPath = config.socketPath;
  activeSocketPath = socketPath;

  // Clean up stale socket file
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  server = createServer((socket: Socket) => {
    let buffer = '';

    socket.on('data', async (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      // Keep last incomplete line in buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: IpcMessage = JSON.parse(line);
          if (config.hookSecret && msg.secret !== config.hookSecret) {
            console.warn(`[IpcServer] Rejected unauthenticated message (type=${msg.type})`);
            continue;
          }
          if (msg.type === 'hook-event') {
            await handleHookEvent(msg.payload);
          } else if (msg.type === 'gate-resolved') {
            await handleGateResolved(msg.payload);
          }
        } catch (err) {
          console.error('[IpcServer] Failed to parse message:', err);
        }
      }
    });

    socket.on('error', (err) => {
      console.error('[IpcServer] Socket error:', err);
    });
  });

  server.listen(socketPath, () => {
    console.log(`[IpcServer] Listening on ${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[IpcServer] Server error:', err);
  });
}

export function stopIpcServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  if (activeSocketPath && existsSync(activeSocketPath)) {
    try { unlinkSync(activeSocketPath); } catch { /* ignore */ }
  }
  activeSocketPath = null;
  discordClient = null;
}

async function handleHookEvent(payload: Record<string, unknown>): Promise<void> {
  const event = payload as {
    type: string;
    sessionId: string;
    source: string;
    metadata?: { cwd?: string; hookEvent?: string; subagent?: Record<string, unknown> };
    timestamp?: number;
  };

  if (!event.sessionId || !event.type) {
    console.warn('[IpcServer] Hook event missing sessionId or type');
    return;
  }

  console.log(`[IpcServer] Received ${event.source} event: ${event.type} for session ${event.sessionId}`);

  const subagent = event.metadata?.subagent;
  const subagentProviderSessionId =
    event.source === 'claude' && subagent?.agentId
      ? sessions.buildClaudeSubagentProviderSessionId(event.sessionId, subagent.agentId as string)
      : undefined;
  let session =
    (subagentProviderSessionId
      ? sessions.getSessionByProviderSession(event.source as 'claude' | 'codex', subagentProviderSessionId)
      : undefined) ?? sessions.getSessionByProviderSession(event.source as 'claude' | 'codex', event.sessionId);

  if (!session && discordClient && event.metadata?.cwd) {
    const registered = await discoverAndRegisterSession(discordClient, {
      provider: event.source as 'claude' | 'codex',
      providerSessionId: event.sessionId,
      cwd: event.metadata.cwd as string,
      discoverySource: event.source === 'claude' ? 'claude-hook' : 'codex-log',
      subagent:
        subagent?.parentProviderSessionId && subagent.agentId
          ? {
              parentProviderSessionId: subagent.parentProviderSessionId as string,
              agentId: subagent.agentId as string,
              agentType: subagent.agentType as string | undefined,
            }
          : undefined,
    });

    if (registered) {
      session = sessions.getSession(registered.sessionId);
      console.log(`[IpcServer] Auto-registered session: ${registered.sessionId}`);
    }
  }

  if (!session) return;

  const channel = discordClient?.channels.cache.get(session.channelId);
  if (!isSessionChannel(channel)) return;

  await updateSessionState(session.id, event as unknown as PlatformEvent, {
    sourceHint: event.source as 'claude' | 'codex',
    channel,
  });

  sessions.updateSession(session.id, {
    lastObservedState: event.type,
    lastObservedEventKey: event.metadata?.hookEvent as string | undefined,
    lastObservedAt: event.timestamp || Date.now(),
  });
}

async function handleGateResolved(payload: Record<string, unknown>): Promise<void> {
  const data = payload as {
    gateId: string;
    action: 'approve' | 'reject';
    sessionId: string;
  };

  console.log(`[IpcServer] Terminal resolved gate ${data.gateId}: ${data.action}`);

  const result = gateCoordinator.notifyTerminalResolved(data.gateId, data.action);
  if (!result.success) {
    console.warn(`[IpcServer] Gate resolution failed: ${result.message}`);
    return;
  }

  const gate = gateCoordinator.getGate(data.gateId);
  if (gate?.discordMessageId) {
    const session = sessions.getSession(data.sessionId);
    if (session) {
      const channel = discordClient?.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (channel) {
        try {
          const message = await channel.messages.fetch(gate.discordMessageId);
          await message.edit({
            components: [],
            embeds: message.embeds.map((e) => ({
              ...e,
              footer: {
                text: `已在终端处理（${data.action === 'approve' ? '批准' : '拒绝'}） - ${new Date().toLocaleTimeString()}`,
              },
            })),
          });
        } catch (err) {
          console.error('[IpcServer] Failed to update Discord message:', err);
        }
      }
    }
  }
}
