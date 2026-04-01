import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PlatformEvent } from './state/types.ts';
import { updateSessionState } from './panel-adapter.ts';
import * as sessions from './thread-manager.ts';
import { discoverAndRegisterSession } from './session-discovery.ts';
import { isPlatformEvent } from './state/event-normalizer.ts';
import type { Client } from 'discord.js';
import { gateCoordinator } from './state/gate-coordinator.ts';
import type { TextChannel } from 'discord.js';

const HOOK_PORT = 23456;
const REQUEST_TIMEOUT_MS = 5000; // 5 秒超时
let server: ReturnType<typeof createServer> | null = null;
let discordClient: Client | null = null;

export function startHookServer(client: Client): void {
  discordClient = client;

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 设置请求超时
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      res.writeHead(408);
      res.end(JSON.stringify({ error: 'Request timeout' }));
    });

    if (req.method === 'POST' && req.url === '/hook-event') {
      await handleHookEvent(req, res);
    } else if (req.method === 'POST' && req.url === '/gate-resolved') {
      await handleGateResolved(req, res);
    } else if (req.method === 'GET' && req.url === '/health') {
      // 健康检查端点
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HOOK_PORT, '127.0.0.1', () => {
    console.log(`[Hook Server] Listening on http://127.0.0.1:${HOOK_PORT}`);
  });

  server.on('error', (err) => {
    console.error(`[Hook Server] Error: ${err.message}`);
  });
}

export function stopHookServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  discordClient = null;
}

async function handleHookEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks).toString();
      const event: PlatformEvent = JSON.parse(body);

      // 验证事件格式
      if (!isPlatformEvent(event)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid event format' }));
        return;
      }

      console.log(
        `[Hook Server] Received ${event.source} event: ${event.type} for session ${event.sessionId}`,
      );

      // 尝试查找已存在的会话
      let session = sessions.getSessionByProviderSession(event.source, event.sessionId);

      // 如果会话不存在，尝试快速注册
      if (!session && discordClient && event.metadata?.cwd) {
        const registered = await discoverAndRegisterSession(discordClient, {
          provider: event.source === 'claude' ? 'claude' : 'codex',
          providerSessionId: event.sessionId,
          cwd: event.metadata.cwd as string,
          discoverySource: event.source === 'claude' ? 'claude-hook' : 'codex-log',
        });

        if (registered) {
          session = sessions.getSession(registered.sessionId);
          console.log(
            `[Hook Server] Auto-registered new session: ${registered.sessionId} (${registered.isNew ? 'new' : 'existing'})`,
          );
        }
      }

      if (!session) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'Session not found and could not register' }));
        return;
      }

      // 获取 Discord channel
      const channel = discordClient?.channels.cache.get(session.channelId);
      if (!channel || !('send' in channel)) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'Channel not found' }));
        return;
      }

      // 更新会话状态
      await updateSessionState(session.id, event, {
        sourceHint: event.source,
        channel: channel as any,
      });

      // 更新最近观察信息
      sessions.updateSession(session.id, {
        lastObservedState: event.type,
        lastObservedEventKey: event.metadata?.hookEvent as string,
        lastObservedAt: event.timestamp,
      });

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[Hook Server] Error handling event:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  req.on('error', (err) => {
    console.error('[Hook Server] Request error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });
}

/**
 * 处理终端侧门控解决通知
 * 参考设计文档 10.3 节：双入口协调
 */
async function handleGateResolved(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks).toString();
      const payload = JSON.parse(body) as {
        gateId: string;
        action: 'approve' | 'reject';
        sessionId: string;
      };

      console.log(
        `[Hook Server] Terminal resolved gate ${payload.gateId}: ${payload.action}`,
      );

      // 通知协调器
      const result = gateCoordinator.notifyTerminalResolved(payload.gateId, payload.action);

      if (!result.success) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: false, message: result.message }));
        return;
      }

      // 更新 Discord 交互卡
      const gate = gateCoordinator.getGate(payload.gateId);
      if (gate?.discordMessageId) {
        const session = sessions.getSession(payload.sessionId);
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
                    text: `已在终端处理（${payload.action === 'approve' ? '批准' : '拒绝'}） - ${new Date().toLocaleTimeString()}`
                  },
                })),
              });
              console.log(`[Hook Server] Updated Discord message for gate ${payload.gateId}`);
            } catch (err) {
              console.error(`[Hook Server] Failed to update Discord message:`, err);
            }
          }
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[Hook Server] Error handling gate resolution:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  req.on('error', (err) => {
    console.error('[Hook Server] Request error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });
}
