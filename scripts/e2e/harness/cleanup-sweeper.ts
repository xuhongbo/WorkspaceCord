import { ChannelType, type CategoryChannel, type Guild, type TextChannel } from 'discord.js';

export const TOPIC_PREFIX = 'wsc-e2e:';

export function encodeChannelTopic(runId: string, expiresAt: number): string {
  return `${TOPIC_PREFIX}${runId}:${expiresAt}`;
}

export function parseChannelTopic(
  topic: string | null,
): { runId: string; expiresAt: number } | null {
  if (!topic || !topic.startsWith(TOPIC_PREFIX)) return null;
  const rest = topic.slice(TOPIC_PREFIX.length);
  const [runId, epoch] = rest.split(':');
  const expiresAt = Number.parseInt(epoch, 10);
  if (!runId || Number.isNaN(expiresAt)) return null;
  return { runId, expiresAt };
}

/** Deletes channels and categories tagged `wsc-e2e:*` that are past their TTL. */
export async function sweepExpired(guild: Guild, now = Date.now()): Promise<number> {
  await guild.channels.fetch();
  let removed = 0;

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    const parsed = parseChannelTopic((channel as TextChannel).topic);
    if (!parsed) continue;
    if (parsed.expiresAt > now) continue;
    try {
      await channel.delete('wsc-e2e expired channel sweep');
      removed++;
    } catch {
      /* best-effort */
    }
  }

  for (const category of guild.channels.cache.values()) {
    if (category.type !== ChannelType.GuildCategory) continue;
    const cat = category as CategoryChannel;
    if (!cat.name.startsWith('wsc-e2e-')) continue;
    if (cat.children.cache.size > 0) continue;
    try {
      await cat.delete('wsc-e2e empty category sweep');
      removed++;
    } catch {
      /* best-effort */
    }
  }

  return removed;
}
