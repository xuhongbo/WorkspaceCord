// 本地会话补漏层（设计文档阶段二：已降级为补漏层）
//
// 职责：
// - 兜底发现钩子失败或日志监控遗漏的会话
// - 定期对账，确保所有本地会话都已注册
// - 优先级低于 Claude 钩子和 Codex 日志监控
//
// 轮询间隔：30 秒（可通过 SESSION_SYNC_INTERVAL_MS 配置）

import type { Client, Guild, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { listCodexSessionsForProjects } from './codex-session-discovery.ts';
import { getAllRegisteredProjects } from '@workspacecord/engine/project-registry';
import { createSession, getAllSessions } from '@workspacecord/engine/session-registry';
import { config } from '@workspacecord/core';
import { isArchivedProviderSession } from './archive-manager.ts';

const SYNC_INTERVAL_MS = config.sessionSyncIntervalMs;
const MAX_SESSIONS_PER_SYNC = 5; // 每次 sync 最多创建 5 个 session，避免 Discord 速率限制
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncStartTimer: ReturnType<typeof setTimeout> | null = null;
let syncInProgress = false;

type SyncSkipReason =
  | 'noGuild'
  | 'noProjects'
  | 'alreadySynced'
  | 'tooOld'
  | 'archived'
  | 'categoryMissing'
  | 'claudeSdkUnavailable'
  | 'claudeProjectError'
  | 'codexProjectMissing'
  | 'codexListFailure'
  | 'sessionCreationFailed';

type SessionSyncStats = {
  runs: number;
  lastRunAt?: number;
  lastRunDurationMs?: number;
  scanned: {
    claude: number;
    codex: number;
  };
  createdSessions: number;
  skipReasons: Record<SyncSkipReason, number>;
  errors: string[];
};

const SYNC_SKIP_REASONS: SyncSkipReason[] = [
  'noGuild',
  'noProjects',
  'alreadySynced',
  'tooOld',
  'archived',
  'categoryMissing',
  'claudeSdkUnavailable',
  'claudeProjectError',
  'codexProjectMissing',
  'codexListFailure',
  'sessionCreationFailed',
];

const sessionSyncStats: SessionSyncStats = {
  runs: 0,
  scanned: { claude: 0, codex: 0 },
  createdSessions: 0,
  skipReasons: initSkipCounters(),
  errors: [],
};

function initSkipCounters(): Record<SyncSkipReason, number> {
  return SYNC_SKIP_REASONS.reduce(
    (acc, reason) => {
      acc[reason] = 0;
      return acc;
    },
    {} as Record<SyncSkipReason, number>,
  );
}

function recordSkip(reason: SyncSkipReason): void {
  sessionSyncStats.skipReasons[reason] =
    (sessionSyncStats.skipReasons[reason] ?? 0) + 1;
}

function recordScan(provider: 'claude' | 'codex'): void {
  sessionSyncStats.scanned[provider]++;
}

function recordCreatedSession(): void {
  sessionSyncStats.createdSessions++;
}

const MAX_SYNC_ERRORS = 50;

function recordError(err: unknown): void {
  sessionSyncStats.errors.push(formatError(err));
  if (sessionSyncStats.errors.length > MAX_SYNC_ERRORS) {
    sessionSyncStats.errors = sessionSyncStats.errors.slice(-MAX_SYNC_ERRORS);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

export function getSessionSyncStats(): SessionSyncStats {
  return {
    runs: sessionSyncStats.runs,
    lastRunAt: sessionSyncStats.lastRunAt,
    lastRunDurationMs: sessionSyncStats.lastRunDurationMs,
    scanned: { ...sessionSyncStats.scanned },
    createdSessions: sessionSyncStats.createdSessions,
    skipReasons: { ...sessionSyncStats.skipReasons },
    errors: [...sessionSyncStats.errors],
  };
}

export function resetSessionSyncStats(): void {
  sessionSyncStats.runs = 0;
  sessionSyncStats.lastRunAt = undefined;
  sessionSyncStats.lastRunDurationMs = undefined;
  sessionSyncStats.scanned = { claude: 0, codex: 0 };
  sessionSyncStats.createdSessions = 0;
  sessionSyncStats.skipReasons = initSkipCounters();
  sessionSyncStats.errors = [];
}

function isWithinRecentSessionWindow(lastActivityAt: number | undefined, now = Date.now()): boolean {
  if (config.sessionSyncRecentDays <= 0) return true;
  if (typeof lastActivityAt !== 'number' || !Number.isFinite(lastActivityAt)) return false;
  const recentSessionWindowMs = config.sessionSyncRecentDays * 24 * 60 * 60 * 1000;
  return lastActivityAt >= now - recentSessionWindowMs;
}

async function runSyncSafely(client: Client): Promise<void> {
  if (syncInProgress) return;
  syncInProgress = true;
  const createdBefore = sessionSyncStats.createdSessions;
  const errorsBefore = sessionSyncStats.errors.length;
  const scannedBefore = { ...sessionSyncStats.scanned };
  try {
    await runSync(client);
  } finally {
    syncInProgress = false;
    const duration = sessionSyncStats.lastRunDurationMs ?? 0;
    const created = sessionSyncStats.createdSessions - createdBefore;
    const errors = sessionSyncStats.errors.length - errorsBefore;
    console.log(
      `[SessionSync] Sync completed in ${duration}ms: `
        + `scanned=${sessionSyncStats.scanned.claude}+${sessionSyncStats.scanned.codex}, `
        + `created=${created}, errors=${errors}`,
    );
  }
}

export function startSync(client: Client): void {
  const effectiveInterval = Math.max(SYNC_INTERVAL_MS, 60_000);
  console.log(`[SessionSync] Starting sync (interval: ${effectiveInterval}ms, first run in 10s)`);
  // 延迟首次 sync，让 bot 先稳定响应交互
  syncStartTimer = setTimeout(() => {
    syncStartTimer = null;
    void runSyncSafely(client);
    syncTimer = setInterval(() => void runSyncSafely(client), effectiveInterval);
  }, 10_000);
}

export function stopSync(): void {
  let stopped = false;
  if (syncStartTimer) {
    clearTimeout(syncStartTimer);
    syncStartTimer = null;
    stopped = true;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    stopped = true;
  }
  if (stopped) {
    console.log('[SessionSync] Sync stopped');
  }
}

async function findOrCreateSessionChannel(
  guild: Guild,
  category: CategoryChannel,
  provider: 'claude' | 'codex',
  providerSessionId: string,
  fallbackName: string,
): Promise<TextChannel> {
  const existing = category.children.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      typeof channel.topic === 'string' &&
      channel.topic.includes(`Provider Session: ${providerSessionId}`),
  ) as TextChannel | undefined;
  if (existing) return existing;

  return guild.channels.create({
    name: fallbackName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${provider} session (synced) | Provider Session: ${providerSessionId}`,
  }).then((channel) => {
    console.log(`[SessionSync] Created channel #${channel.name} for ${provider} session ${providerSessionId}`);
    return channel as TextChannel;
  });
}

async function syncPersistentSession(
  guild: Guild,
  category: CategoryChannel,
  projectName: string,
  directory: string,
  provider: 'claude' | 'codex',
  providerSessionId: string,
  labelHint: string,
): Promise<void> {
  const base =
    labelHint
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || providerSessionId.slice(0, 12);

  const channel = await findOrCreateSessionChannel(
    guild,
    category,
    provider,
    providerSessionId,
    `${provider}-${base}`.slice(0, 100),
  );

  await createSession({
    channelId: channel.id,
    categoryId: category.id,
    projectName,
    agentLabel: labelHint,
    provider,
    providerSessionId,
    directory,
    type: 'persistent',
    discoverySource: 'sync',
  });
}

export async function runSync(client: Client): Promise<void> {
  const start = Date.now();
  sessionSyncStats.runs++;
  sessionSyncStats.lastRunAt = start;
  sessionSyncStats.errors = [];
  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      recordSkip('noGuild');
      return;
    }
    const now = Date.now();

    const projects = getAllRegisteredProjects().filter((project) => project.discordCategoryId);
    if (projects.length === 0) {
      recordSkip('noProjects');
      return;
    }

    const existingProviderIds = new Set(
      getAllSessions()
        .map((session) => session.providerSessionId)
        .filter(Boolean),
    );

    let createdThisRun = 0;

    try {
      const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
      for (const project of projects) {
        if (createdThisRun >= MAX_SESSIONS_PER_SYNC) break;
        const category = guild.channels.cache.get(project.discordCategoryId!) as
          | CategoryChannel
          | undefined;
        if (!category || category.type !== ChannelType.GuildCategory) {
          recordSkip('categoryMissing');
          continue;
        }

        try {
          const claudeSessions = await claudeSdk.listSessions({ dir: project.path, limit: 50 });
          for (const item of claudeSessions) {
            if (createdThisRun >= MAX_SESSIONS_PER_SYNC) break;
            // 让出事件循环，避免长时间阻塞 interaction 处理
            await new Promise(r => setTimeout(r, 0));
            recordScan('claude');
            if (!item?.sessionId) continue;
            if ((item as Record<string, unknown>).parentSessionId) {
              recordSkip('alreadySynced');
              continue;
            }
            if (item.sessionId.includes('subagent:')) {
              recordSkip('alreadySynced');
              continue;
            }
            if (existingProviderIds.has(item.sessionId)) {
              recordSkip('alreadySynced');
              continue;
            }
            if (!isWithinRecentSessionWindow(item.lastModified, now)) {
              recordSkip('tooOld');
              continue;
            }
            if (isArchivedProviderSession('claude', item.sessionId)) {
              recordSkip('archived');
              continue;
            }
            try {
              await syncPersistentSession(
                guild,
                category,
                project.name,
                project.path,
                'claude',
                item.sessionId,
                item.summary || item.firstPrompt || item.sessionId,
              );
              existingProviderIds.add(item.sessionId);
              createdThisRun++;
              recordCreatedSession();
            } catch (err) {
              console.error(
                `[SessionSync] Failed to create claude session ${item.sessionId}: ${formatError(err)}`,
              );
              recordSkip('sessionCreationFailed');
              recordError(err);
            }
          }
        } catch (err) {
          recordSkip('claudeProjectError');
          recordError(err);
        }
      }
    } catch (err) {
      recordSkip('claudeSdkUnavailable');
      recordError(err);
    }

    let codexSessions: Awaited<ReturnType<typeof listCodexSessionsForProjects>> = [];
    try {
      codexSessions = await listCodexSessionsForProjects(projects.map((project) => project.path));
    } catch (err) {
      recordSkip('codexListFailure');
      recordError(err);
      codexSessions = [];
    }

    for (const session of codexSessions) {
      if (createdThisRun >= MAX_SESSIONS_PER_SYNC) break;
      await new Promise(r => setTimeout(r, 0));
      recordScan('codex');
      if (existingProviderIds.has(session.id)) {
        recordSkip('alreadySynced');
        continue;
      }
      if (!isWithinRecentSessionWindow(session.updatedAt, now)) {
        recordSkip('tooOld');
        continue;
      }
      if (isArchivedProviderSession('codex', session.id)) {
        recordSkip('archived');
        continue;
      }
      const project = projects.find((item) => item.path === session.projectPath);
      if (!project?.discordCategoryId) {
        recordSkip('codexProjectMissing');
        continue;
      }
      const category = guild.channels.cache.get(project.discordCategoryId) as
        | CategoryChannel
        | undefined;
      if (!category || category.type !== ChannelType.GuildCategory) {
        recordSkip('categoryMissing');
        continue;
      }
      try {
        await syncPersistentSession(
          guild,
          category,
          project.name,
          session.cwd,
          'codex',
          session.id,
          session.threadName,
        );
        existingProviderIds.add(session.id);
        createdThisRun++;
        recordCreatedSession();
      } catch (err) {
        console.error(
          `[SessionSync] Failed to create codex session ${session.id}: ${formatError(err)}`,
        );
        recordSkip('sessionCreationFailed');
        recordError(err);
      }
    }

    if (createdThisRun >= MAX_SESSIONS_PER_SYNC) {
      console.log(`[SessionSync] Reached per-sync limit (${MAX_SESSIONS_PER_SYNC}), deferring remaining to next run`);
    }
  } finally {
    sessionSyncStats.lastRunDurationMs = Date.now() - start;
  }
}
