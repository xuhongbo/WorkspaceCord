import type { Guild } from 'discord.js';
import { archiveSession } from './archive-manager.ts';
import { endSession, getAllSessions, getSession } from './thread-manager.ts';
import type { ThreadSession } from './types.ts';

export interface ProjectCleanupPreview {
  categoryId: string;
  projectName: string;
  protectedChannels: {
    currentChannelId: string;
    controlChannelId?: string;
    historyChannelId?: string;
  };
  archiveCandidates: ThreadSession[];
  skippedGenerating: ThreadSession[];
  skippedUnknown: ThreadSession[];
}

export interface SessionCleanupResult {
  deletedChannels: number;
  missingChannels: number;
  endedSessions: number;
  skippedSessions: number;
  failed: Array<{
    sessionId: string;
    channelId?: string;
    message: string;
  }>;
}

export interface SessionArchiveByIdResult {
  archivedSessions: number;
  skippedGenerating: number;
  missingSessions: number;
  failed: Array<{
    sessionId: string;
    channelId?: string;
    message: string;
  }>;
}

async function resolveChannel(guild: Guild, channelId: string) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

function sortSessions(a: ThreadSession, b: ThreadSession): number {
  const byActivity = (a.lastActivity ?? 0) - (b.lastActivity ?? 0);
  if (byActivity !== 0) return byActivity;
  return a.agentLabel.localeCompare(b.agentLabel);
}

export function buildProjectCleanupPreview(input: {
  categoryId: string;
  currentChannelId: string;
  controlChannelId?: string;
  historyChannelId?: string;
  projectName: string;
}): ProjectCleanupPreview {
  const protectedChannelIds = new Set(
    [input.currentChannelId, input.controlChannelId, input.historyChannelId].filter(Boolean),
  );
  const preview: ProjectCleanupPreview = {
    categoryId: input.categoryId,
    projectName: input.projectName,
    protectedChannels: {
      currentChannelId: input.currentChannelId,
      controlChannelId: input.controlChannelId,
      historyChannelId: input.historyChannelId,
    },
    archiveCandidates: [],
    skippedGenerating: [],
    skippedUnknown: [],
  };

  for (const session of getAllSessions()) {
    if (session.categoryId !== input.categoryId) continue;
    if (session.type !== 'persistent') continue;
    if (protectedChannelIds.has(session.channelId)) continue;
    if (session.isGenerating) {
      preview.skippedGenerating.push(session);
      continue;
    }
    preview.archiveCandidates.push(session);
  }

  preview.archiveCandidates.sort(sortSessions);
  preview.skippedGenerating.sort(sortSessions);
  preview.skippedUnknown.sort(sortSessions);

  return preview;
}

export async function cleanupSessionsById(
  guild: Guild,
  sessionIds: Iterable<string>,
  deleteReason = 'workspacecord session cleanup',
): Promise<SessionCleanupResult> {
  const result: SessionCleanupResult = {
    deletedChannels: 0,
    missingChannels: 0,
    endedSessions: 0,
    skippedSessions: 0,
    failed: [],
  };

  for (const sessionId of new Set(Array.from(sessionIds).filter(Boolean))) {
    const session = getSession(sessionId);
    if (!session) {
      result.skippedSessions += 1;
      continue;
    }

    try {
      const channel = await resolveChannel(guild, session.channelId);
      if (channel) {
        await channel.delete(deleteReason);
        result.deletedChannels += 1;
        // Throttle to avoid Discord rate limits on bulk channel deletions
        await new Promise((r) => setTimeout(r, 300));
      } else {
        result.missingChannels += 1;
        console.warn(`[Housekeeping] Channel ${session.channelId} for session ${sessionId} not found during cleanup`);
      }

      await endSession(session.id);
      result.endedSessions += 1;
    } catch (error) {
      console.error(`[Housekeeping] Failed to cleanup session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      result.failed.push({
        sessionId: session.id,
        channelId: session.channelId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(`[Housekeeping] Cleanup result: ${result.deletedChannels} channels deleted, ${result.missingChannels} missing, ${result.endedSessions} sessions ended, ${result.skippedSessions} skipped, ${result.failed.length} failed`);

  return result;
}

export async function archiveSessionsById(
  guild: Guild,
  sessionIds: Iterable<string>,
  summary = 'Bulk cleanup from Discord command',
): Promise<SessionArchiveByIdResult> {
  const result: SessionArchiveByIdResult = {
    archivedSessions: 0,
    skippedGenerating: 0,
    missingSessions: 0,
    failed: [],
  };

  for (const sessionId of new Set(Array.from(sessionIds).filter(Boolean))) {
    const session = getSession(sessionId);
    if (!session || session.type !== 'persistent') {
      result.missingSessions += 1;
      continue;
    }

    if (session.isGenerating) {
      result.skippedGenerating += 1;
      continue;
    }

    try {
      await archiveSession(session, guild, summary);
      result.archivedSessions += 1;
    } catch (error) {
      console.error(`[Housekeeping] Failed to archive session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      result.failed.push({
        sessionId: session.id,
        channelId: session.channelId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(`[Housekeeping] Archive result: ${result.archivedSessions} archived, ${result.skippedGenerating} skipped, ${result.missingSessions} missing, ${result.failed.length} failed`);

  return result;
}

export async function reconcileSessionRecordsWithGuild(
  guild: Guild,
): Promise<{ checkedSessions: number; endedMissingSessions: number }> {
  const sessions = getAllSessions();
  let endedMissingSessions = 0;

  for (const session of sessions) {
    const channel = await resolveChannel(guild, session.channelId);
    if (channel) continue;

    console.warn(`[Housekeeping] Session ${session.id} channel ${session.channelId} missing from guild — ending session`);
    await endSession(session.id);
    endedMissingSessions += 1;
  }

  console.log(`[Housekeeping] Reconciliation: checked ${sessions.length} sessions, ended ${endedMissingSessions} with missing channels`);

  return {
    checkedSessions: sessions.length,
    endedMissingSessions,
  };
}
