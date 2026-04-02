import { ChannelType, EmbedBuilder, type Guild, type ForumChannel } from 'discord.js';
import { Store } from './persistence.ts';
import { config } from './config.ts';
import { getAllSessions, endSession, getSessionsByCategory } from './thread-manager.ts';
import { getProject, setHistoryChannelId } from './project-manager.ts';
import type { ThreadSession, ArchivedSession } from './types.ts';

const archiveStore = new Store<ArchivedSession[]>('archived.json');

let archived: ArchivedSession[] = [];

export async function loadArchived(): Promise<void> {
  archived = (await archiveStore.read()) || [];
}

async function saveArchived(): Promise<void> {
  await archiveStore.write(archived);
}

export function getArchivedSessions(categoryId: string): ArchivedSession[] {
  return archived.filter((a) => a.categoryId === categoryId);
}

export function isArchivedProviderSession(
  provider: ThreadSession['provider'],
  providerSessionId: string | undefined,
): boolean {
  if (!providerSessionId) return false;
  return archived.some(
    (record) =>
      record.provider === provider && record.providerSessionId === providerSessionId,
  );
}

// ─── Ensure #history forum channel ────────────────────────────────────────────

async function ensureHistoryChannel(
  guild: Guild,
  categoryId: string,
): Promise<ForumChannel | null> {
  const project = getProject(categoryId);
  if (!project) return null;

  // Check if we already have a stored historyChannelId
  if (project.historyChannelId) {
    const existing = guild.channels.cache.get(project.historyChannelId);
    if (existing?.type === ChannelType.GuildForum) {
      return existing as ForumChannel;
    }
  }

  // Try to find an existing #history Forum channel in the category
  const existing = guild.channels.cache.find(
    (ch) =>
      ch.parentId === categoryId && ch.name === 'history' && ch.type === ChannelType.GuildForum,
  );
  if (existing?.type === ChannelType.GuildForum) {
    setHistoryChannelId(categoryId, existing.id);
    return existing as ForumChannel;
  }

  // Create it
  try {
    const forum = await guild.channels.create({
      name: 'history',
      type: ChannelType.GuildForum,
      parent: categoryId,
      topic: 'Archived agent sessions for this project',
      reason: 'Auto-created by workspacecord for session archiving',
    });
    setHistoryChannelId(categoryId, forum.id);
    return forum;
  } catch (err) {
    console.error(`[archive-manager] Failed to create #history forum: ${(err as Error).message}`);
    return null;
  }
}

// ─── Archive a single session ─────────────────────────────────────────────────

export async function archiveSession(
  session: ThreadSession,
  guild: Guild,
  summary?: string,
): Promise<ArchivedSession | null> {
  const historyForum = await ensureHistoryChannel(guild, session.categoryId);

  // Build archive record
  const record: ArchivedSession = {
    id: session.id,
    categoryId: session.categoryId,
    agentLabel: session.agentLabel,
    provider: session.provider,
    providerSessionId: session.providerSessionId,
    directory: session.directory,
    mode: session.mode,
    createdAt: session.createdAt,
    archivedAt: Date.now(),
    messageCount: session.messageCount,
    totalCost: session.totalCost,
    summary: summary || session.workflowState.lastWorkerSummary,
  };

  // Create a Forum post (thread) in #history
  if (historyForum) {
    try {
      const date = new Date(session.createdAt).toISOString().slice(0, 10);
      const postName = `[${session.provider}] ${session.agentLabel} · ${date}`.slice(0, 100);

      const embed = new EmbedBuilder()
        .setColor(0x95a5a6)
        .setTitle(`Archived: ${session.agentLabel}`)
        .addFields(
          { name: 'Provider', value: session.provider, inline: true },
          { name: 'Mode', value: session.mode, inline: true },
          { name: 'Messages', value: `${session.messageCount}`, inline: true },
          { name: 'Directory', value: `\`${session.directory}\``, inline: false },
          {
            name: 'Active',
            value: `${formatDuration(record.archivedAt - record.createdAt)}`,
            inline: true,
          },
          {
            name: 'Cost',
            value: session.totalCost > 0 ? `$${session.totalCost.toFixed(4)}` : 'N/A',
            inline: true,
          },
        );

      if (record.summary) {
        embed.addFields({ name: 'Last Summary', value: record.summary.slice(0, 1000) });
      }

      const post = await historyForum.threads.create({
        name: postName,
        message: { embeds: [embed] },
        reason: `Session archived by workspacecord`,
      });

      record.forumPostId = post.id;
    } catch (err) {
      console.error(`[archive-manager] Failed to create forum post: ${(err as Error).message}`);
    }
  }

  // Delete the session channel if it exists (persistent sessions only)
  if (session.type === 'persistent') {
    try {
      const channel = guild.channels.cache.get(session.channelId);
      if (channel) {
        await channel.delete(`Session archived by workspacecord`);
      }
    } catch (err) {
      console.error(
        `[archive-manager] Failed to delete session channel: ${(err as Error).message}`,
      );
    }
  }

  // End the session record
  try {
    await endSession(session.id);
  } catch {
    /* already ended */
  }

  // Persist the archive record
  archived.push(record);
  await saveArchived();

  return record;
}

// ─── Auto-archive check ───────────────────────────────────────────────────────

/**
 * For each project, check:
 * 1. Sessions inactive longer than AUTO_ARCHIVE_DAYS
 * 2. Active session count exceeds MAX_ACTIVE_SESSIONS — archive oldest first
 */
export async function checkAutoArchive(guild: Guild): Promise<void> {
  if (!config.autoArchiveDays && !config.maxActiveSessionsPerProject) return;

  const now = Date.now();
  const inactiveThreshold = config.autoArchiveDays
    ? config.autoArchiveDays * 24 * 60 * 60 * 1000
    : 0;

  // Group sessions by category
  const byCategory = new Map<string, ThreadSession[]>();
  for (const session of getAllSessions()) {
    if (session.type !== 'persistent') continue; // only archive top-level sessions
    if (session.isGenerating) continue;

    const list = byCategory.get(session.categoryId) ?? [];
    list.push(session);
    byCategory.set(session.categoryId, list);
  }

  for (const [categoryId, categorySessions] of byCategory) {
    const toArchive = new Set<string>();

    // Inactive sessions
    if (inactiveThreshold > 0) {
      for (const s of categorySessions) {
        if (now - s.lastActivity > inactiveThreshold) {
          toArchive.add(s.id);
        }
      }
    }

    // Excess sessions — sort by lastActivity ascending (oldest first)
    const maxActive = config.maxActiveSessionsPerProject;
    if (maxActive > 0 && categorySessions.length > maxActive) {
      const sorted = [...categorySessions].sort((a, b) => a.lastActivity - b.lastActivity);
      const excess = categorySessions.length - maxActive;
      for (let i = 0; i < excess; i++) {
        toArchive.add(sorted[i].id);
      }
    }

    for (const sessionId of toArchive) {
      const session = categorySessions.find((s) => s.id === sessionId);
      if (!session) continue;
      console.log(
        `[archive-manager] Auto-archiving session "${session.agentLabel}" (inactive: ${Math.round((now - session.lastActivity) / 86400000)}d)`,
      );
      await archiveSession(
        session,
        guild,
        'Auto-archived due to inactivity or session limit.',
      ).catch((err) =>
        console.error(
          `[archive-manager] Auto-archive failed for "${session.agentLabel}": ${err.message}`,
        ),
      );
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
