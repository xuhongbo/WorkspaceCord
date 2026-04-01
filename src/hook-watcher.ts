import fs from 'node:fs';
import { Client } from 'discord.js';
import { discoverAndRegisterSession } from './session-discovery.ts';
import * as sessions from './thread-manager.ts';
import { updateSessionState } from './panel-adapter.ts';

const EVENT_QUEUE = '/tmp/workspacecord-hook-events.jsonl';
const POLL_INTERVAL = 500; // 500ms

let lastReadPosition = 0;
let watcherInterval: NodeJS.Timeout | null = null;
let discordClient: Client | null = null;

export function startHookWatcher(client: Client) {
  discordClient = client;

  // 初始化：如果文件存在，跳到末尾
  if (fs.existsSync(EVENT_QUEUE)) {
    const stats = fs.statSync(EVENT_QUEUE);
    lastReadPosition = stats.size;
  }

  watcherInterval = setInterval(async () => {
    await pollEvents();
  }, POLL_INTERVAL);

  console.log('[HookWatcher] Started polling', EVENT_QUEUE);
}

export function stopHookWatcher() {
  if (watcherInterval) {
    clearInterval(watcherInterval);
    watcherInterval = null;
  }
  console.log('[HookWatcher] Stopped');
}

async function pollEvents() {
  if (!fs.existsSync(EVENT_QUEUE)) {
    return;
  }

  const stats = fs.statSync(EVENT_QUEUE);
  if (stats.size <= lastReadPosition) {
    return; // 没有新数据
  }

  const fd = fs.openSync(EVENT_QUEUE, 'r');
  const buffer = Buffer.alloc(stats.size - lastReadPosition);
  fs.readSync(fd, buffer, 0, buffer.length, lastReadPosition);
  fs.closeSync(fd);

  lastReadPosition = stats.size;

  const lines = buffer.toString('utf8').trim().split('\n');

  for (const line of lines) {
    if (!line) continue;

    try {
      const event = JSON.parse(line);
      await handleHookEvent(event);
    } catch (err) {
      console.error('[HookWatcher] Failed to parse event:', err);
    }
  }
}

async function handleHookEvent(event: any) {
  const { sessionId, state, metadata } = event;

  if (!sessionId || !state) {
    return;
  }

  console.log(`[HookWatcher] Event: ${state} for session ${sessionId}`);

  let session = sessions.getSessionByProviderSession('claude', sessionId);

  // 如果会话不存在且有 cwd，尝试自动注册
  if (!session && metadata?.cwd && discordClient) {
    const result = await discoverAndRegisterSession(discordClient, {
      provider: 'claude',
      providerSessionId: sessionId,
      cwd: metadata.cwd,
      discoverySource: 'claude-hook',
    });
    if (result) {
      session = sessions.getSession(result.sessionId);
    }
  }

  if (!session) {
    console.log(`[HookWatcher] Session ${sessionId} not found, skipping`);
    return;
  }

  // 更新会话状态
  await updateSessionState(session.id, {
    type: state,
    sessionId: session.id,
    source: 'claude',
    confidence: 'high',
    timestamp: metadata?.timestamp || Date.now(),
  });
}
