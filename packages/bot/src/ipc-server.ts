import { createServer, type Socket } from 'node:net';
import { unlinkSync, existsSync, chmodSync } from 'node:fs';
import type { Client, TextChannel } from 'discord.js';
import type { SessionChannel } from './discord-types.ts';
import { config } from '@workspacecord/core';
import { updateSessionState } from './panel-adapter.ts';
import { getSessionByProviderSession, updateSession } from '@workspacecord/engine/session-registry';
import { getSessionView } from '@workspacecord/engine/session-context';
import { buildClaudeSubagentProviderSessionId } from './session-local-registration.ts';
import { discoverAndRegisterSession } from './session-discovery.ts';
import { gateCoordinator } from '@workspacecord/state';
import type { PlatformEvent } from '@workspacecord/state';

let server: ReturnType<typeof createServer> | null = null;
let discordClient: Client | null = null;
let activeSocketPath: string | null = null;
const activeSockets = new Set<Socket>();

// IPC 事件节流：同一 session 的同类事件 500ms 内只处理一次
const IPC_THROTTLE_MS = 500;
const THROTTLE_MAP_MAX_SIZE = 500;
const UNTHROTTLED_EVENTS = new Set(['awaiting_human', 'session_ended', 'errored', 'human_resolved']);
const lastIpcEventTime = new Map<string, number>();

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
    activeSockets.add(socket);
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

    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  server.listen(socketPath, () => {
    // 仅 owner 可读写（0600），防止 /tmp 下其它本地进程连上来调用内部 IPC。
    // Windows 命名管道不支持 chmod；失败时记录但不阻塞启动。
    if (process.platform !== 'win32') {
      try {
        chmodSync(socketPath, 0o600);
      } catch (err) {
        console.warn(
          `[IpcServer] Failed to set 0600 on socket ${socketPath}: ${(err as Error).message}`,
        );
      }
    }
    console.log(`[IpcServer] Listening on ${socketPath}`);
  });

  server.on('error', (err) => {
    console.error('[IpcServer] Server error:', err);
  });
}

export function stopIpcServer(): void {
  for (const socket of activeSockets) {
    socket.destroy();
  }
  activeSockets.clear();
  if (server) {
    server.close();
    server = null;
  }
  if (activeSocketPath && existsSync(activeSocketPath)) {
    try { unlinkSync(activeSocketPath); } catch { /* ignore */ }
  }
  activeSocketPath = null;
  discordClient = null;
  lastIpcEventTime.clear();
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

  // 节流：非关键事件 500ms 内去重
  if (!UNTHROTTLED_EVENTS.has(event.type)) {
    const throttleKey = `${event.sessionId}:${event.type}`;
    const now = Date.now();
    const lastTime = lastIpcEventTime.get(throttleKey) ?? 0;
    if (now - lastTime < IPC_THROTTLE_MS) {
      return;
    }
    lastIpcEventTime.set(throttleKey, now);
    // 防止 throttle map 无限增长
    if (lastIpcEventTime.size > THROTTLE_MAP_MAX_SIZE) {
      // 先剪掉过期条目
      const cutoff = now - IPC_THROTTLE_MS * 10;
      for (const [key, time] of lastIpcEventTime) {
        if (time < cutoff) lastIpcEventTime.delete(key);
      }
      // 若突发高负载导致所有条目都很新，强制按时间淘汰最旧的 N 条，保证严格上限
      if (lastIpcEventTime.size > THROTTLE_MAP_MAX_SIZE) {
        const entries = [...lastIpcEventTime.entries()].sort((a, b) => a[1] - b[1]);
        const toRemove = entries.length - THROTTLE_MAP_MAX_SIZE;
        for (let i = 0; i < toRemove; i++) {
          lastIpcEventTime.delete(entries[i][0]);
        }
      }
    }
  }

  console.log(`[IpcServer] Received ${event.source} event: ${event.type} for session ${event.sessionId}`);

  const subagent = event.metadata?.subagent;
  const subagentProviderSessionId =
    event.source === 'claude' && subagent?.agentId
      ? buildClaudeSubagentProviderSessionId(event.sessionId, subagent.agentId as string)
      : undefined;
  let session =
    (subagentProviderSessionId
      ? getSessionByProviderSession(event.source as 'claude' | 'codex', subagentProviderSessionId)
      : undefined) ?? getSessionByProviderSession(event.source as 'claude' | 'codex', event.sessionId);

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
      session = getSessionView(registered.sessionId);
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

  updateSession(session.id, {
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
    const session = getSessionView(data.sessionId);
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
