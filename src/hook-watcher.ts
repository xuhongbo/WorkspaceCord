import fs from 'node:fs';
import { Client } from 'discord.js';
import { discoverAndRegisterSession } from './session-discovery.ts';
import * as sessions from './thread-manager.ts';
import { updateSessionState } from './panel-adapter.ts';
import type { PlatformEventType } from './state/types.ts';

const EVENT_QUEUE = '/tmp/workspacecord-hook-events.jsonl';
const POLL_INTERVAL = 500; // 500ms

let lastReadPosition = 0;
let watcherInterval: NodeJS.Timeout | null = null;
let discordClient: Client | null = null;

interface HookQueueEvent {
  sessionId?: string;
  state?: PlatformEventType;
  metadata?: {
    cwd?: string;
    timestamp?: number;
    subagent?: {
      parentProviderSessionId?: string;
      agentId?: string;
      agentType?: string;
    };
  };
}

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

  let stats: fs.Stats;
  try {
    stats = fs.statSync(EVENT_QUEUE);
  } catch (err) {
    console.error('[HookWatcher] Failed to stat event queue:', err);
    return;
  }

  if (stats.size < lastReadPosition) {
    console.log(`[HookWatcher] Event queue shrank from ${lastReadPosition} to ${stats.size} bytes — resetting position`);
    lastReadPosition = 0;
  }

  if (stats.size <= lastReadPosition) {
    return; // 没有新数据
  }

  const bytesRead = stats.size - lastReadPosition;
  if (bytesRead > 10_000) {
    console.log(`[HookWatcher] Event queue grew by ${bytesRead} bytes since last poll`);
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(EVENT_QUEUE, 'r');
    const buffer = Buffer.alloc(bytesRead);
    fs.readSync(fd, buffer, 0, buffer.length, lastReadPosition);
    fs.closeSync(fd);
    fd = undefined;

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
  } catch (err) {
    console.error('[HookWatcher] Failed to read event queue:', err);
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return;
  }
}

async function handleHookEvent(event: HookQueueEvent) {
  const { sessionId, state, metadata } = event;

  if (!sessionId || !state) {
    const truncated = JSON.stringify(event).slice(0, 100);
    console.warn(`[HookWatcher] Event missing sessionId or state: ${truncated}`);
    return;
  }

  console.log(`[HookWatcher] Event: ${state} for session ${sessionId}`);

  const subagent = event.metadata?.subagent;
  const subagentProviderSessionId =
    subagent?.agentId
      ? sessions.buildClaudeSubagentProviderSessionId(sessionId, subagent.agentId)
      : undefined;
  let session =
    (subagentProviderSessionId
      ? sessions.getSessionByProviderSession('claude', subagentProviderSessionId)
      : undefined) ?? sessions.getSessionByProviderSession('claude', sessionId);

  // 如果会话不存在且有 cwd，尝试自动注册
  if (!session && metadata?.cwd && discordClient) {
    const result = await discoverAndRegisterSession(discordClient, {
      provider: 'claude',
      providerSessionId: sessionId,
      cwd: metadata.cwd,
      discoverySource: 'claude-hook',
      subagent:
        subagent?.parentProviderSessionId && subagent.agentId
          ? {
              parentProviderSessionId: subagent.parentProviderSessionId,
              agentId: subagent.agentId,
              agentType: subagent.agentType,
            }
          : undefined,
    });
    if (result) {
      console.log(`[HookWatcher] Auto-registered session ${result.sessionId} (cwd: ${metadata.cwd})`);
      session = sessions.getSession(result.sessionId);
    } else {
      console.log(`[HookWatcher] Auto-registration failed for sessionId=${sessionId} cwd=${metadata.cwd}`);
    }
  }

  if (!session) {
    console.log(`[HookWatcher] Session ${sessionId} not found, skipping`);
    return;
  }

  // 更新会话状态
  const stateResult = await updateSessionState(session.id, {
    type: state,
    sessionId: session.id,
    source: 'claude',
    confidence: 'high',
    timestamp: metadata?.timestamp || Date.now(),
  });
  if (stateResult) {
    console.log(`[HookWatcher] State updated for session ${session.id}: ${state}`);
  } else {
    console.error(`[HookWatcher] Failed to update state for session ${session.id}: ${state}`);
  }
}
