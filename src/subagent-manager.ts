import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from './config.ts';
import { createSession, endSession, getAllSessions } from './thread-manager.ts';
import type { ThreadSession, ProviderName } from './types.ts';

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
    try {
      await thread.send(`*Subagent complete: ${summary}*`);
    } catch {
      /* thread may already be archived */
    }
  }

  try {
    await thread.setArchived(true, 'Subagent task completed');
  } catch {
    /* best effort */
  }

  try {
    await endSession(session.id);
  } catch {
    /* already ended */
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

  for (const session of getSubagentSessions()) {
    if (checked.has(session.id)) continue;
    checked.add(session.id);

    const idle = now - session.lastActivity;
    if (idle < SUBAGENT_IDLE_TIMEOUT_MS) continue;
    if (session.isGenerating) continue;

    const thread = getThread(session.channelId);
    if (!thread) {
      await endSession(session.id).catch(() => {});
      continue;
    }

    await archiveSubagent(session, thread, 'Idle timeout reached.');
  }
}

function getSubagentSessions(): ThreadSession[] {
  return getAllSessions().filter((s) => s.type === 'subagent');
}
