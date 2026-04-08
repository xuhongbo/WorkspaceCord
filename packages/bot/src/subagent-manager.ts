import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from '@workspacecord/core';
import { createSession, endSession, getAllSessions } from '@workspacecord/engine/session-registry';
import type { ThreadSession, ProviderName } from '@workspacecord/core';
import { sendSystemNotice } from './discord/delivery-notices.ts';

// Watchdog: archive idle subagents after 1 hour
const SUBAGENT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export function canSpawnSubagent(parentSession: ThreadSession): boolean {
  return parentSession.subagentDepth < config.maxSubagentDepth;
}

/**
 * Spawn an ephemeral subagent as a Thread under the parent session's TextChannel.
 * The subagent session's channelId = the Thread ID.
 */
export async function spawnSubagent(
  parentSession: ThreadSession,
  label: string,
  provider: ProviderName,
  sessionChannel: TextChannel,
): Promise<ThreadSession> {
  if (!canSpawnSubagent(parentSession)) {
    console.warn(`[SubagentManager] Depth limit hit for session ${parentSession.id} (max depth ${config.maxSubagentDepth})`);
    throw new Error(
      `Max subagent depth (${config.maxSubagentDepth}) reached. Cannot spawn further subagents.`,
    );
  }

  const threadName = `[sub:${provider}] ${label}`.slice(0, 100);

  const thread = await sessionChannel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    reason: `Subagent spawned by session ${parentSession.id}`,
  });

  const session = await createSession({
    channelId: thread.id, // Subagent's primary ID is the Thread
    categoryId: parentSession.categoryId,
    projectName: parentSession.projectName,
    agentLabel: label,
    provider,
    directory: parentSession.directory,
    type: 'subagent',
    parentChannelId: parentSession.channelId, // Parent session's TextChannel
    subagentDepth: parentSession.subagentDepth + 1,
    mode: parentSession.mode,
    claudePermissionMode:
      provider === 'claude' ? parentSession.claudePermissionMode : undefined,
  });

  console.log(`[SubagentManager] Spawned subagent "${label}" session ${session.id} thread ${thread.id} (depth ${session.subagentDepth}, parent ${parentSession.id})`);

  return session;
}

/**
 * Archive a completed subagent thread and post a completion summary.
 */
export async function archiveSubagent(
  session: ThreadSession,
  thread: AnyThreadChannel,
  summary?: string,
): Promise<void> {
  if (summary) {
    await sendSystemNotice(thread, session.id, `*Subagent complete: ${summary}*`);
  }

  try {
    await thread.setArchived(true, 'Subagent task completed');
  } catch (error) {
    console.warn(`[SubagentManager] Failed to archive thread ${thread.id} for subagent ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await endSession(session.id);
    console.log(`[SubagentManager] Archived subagent ${session.id} thread ${thread.id}${summary ? ` — ${summary}` : ''}`);
  } catch (error) {
    console.warn(`[SubagentManager] Failed to end session for subagent ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get all active subagents for a parent session.
 */
export function getSubagents(parentSession: ThreadSession): ThreadSession[] {
  return getAllSessions().filter(
    (s) => s.type === 'subagent' && s.parentChannelId === parentSession.channelId,
  );
}

/**
 * Watchdog: archive subagent threads that have been idle too long.
 * Call periodically (e.g. every 5 minutes).
 */
export async function runSubagentWatchdog(
  getThread: (threadId: string) => AnyThreadChannel | undefined,
): Promise<void> {
  const now = Date.now();
  const checked = new Set<string>();
  let archived = 0;
  let errors = 0;

  for (const session of getSubagentSessions()) {
    if (checked.has(session.id)) continue;
    checked.add(session.id);

    const idle = now - session.lastActivity;
    if (idle < SUBAGENT_IDLE_TIMEOUT_MS) continue;
    if (session.isGenerating) continue;

    const thread = getThread(session.channelId);
    if (!thread) {
      await endSession(session.id).catch(() => {});
      console.log(`[SubagentWatchdog] Ended orphaned subagent ${session.id} — thread ${session.channelId} not found`);
      continue;
    }

    try {
      await archiveSubagent(session, thread, 'Idle timeout reached.');
      archived += 1;
    } catch (error) {
      console.error(`[SubagentWatchdog] Failed to archive idle subagent ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      errors += 1;
    }
  }

  console.log(`[SubagentWatchdog] Watchdog run: checked ${checked.size} subagents, archived ${archived}, errors ${errors}`);
}

function getSubagentSessions(): ThreadSession[] {
  return getAllSessions().filter((s) => s.type === 'subagent');
}
