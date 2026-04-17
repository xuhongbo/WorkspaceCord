import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, TextChannel } from 'discord.js';
import { stateMachine } from '../../../packages/state/src/state-machine.ts';

export function artifactsDirFor(runId: string, label: string): string {
  return join(process.cwd(), 'local-acceptance', 'e2e', runId, label);
}

export async function snapshotChannels(
  runId: string,
  label: string,
  channels: TextChannel[],
): Promise<void> {
  const dir = artifactsDirFor(runId, label);
  mkdirSync(dir, { recursive: true });

  const dump: Array<{
    channelId: string;
    channelName: string;
    messages: Array<{
      id: string;
      createdAt: string;
      authorTag: string;
      content: string;
      embeds: unknown[];
      components: unknown[];
      edited: string | null;
    }>;
  }> = [];

  for (const ch of channels) {
    const collected = await ch.messages.fetch({ limit: 50 }).catch(() => null);
    if (!collected) continue;
    const msgs = Array.from(collected.values()).sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp,
    );
    dump.push({
      channelId: ch.id,
      channelName: ch.name,
      messages: msgs.map((m: Message) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        authorTag: m.author?.tag ?? 'unknown',
        content: m.content,
        embeds: m.embeds.map((e) => e.toJSON()),
        components: m.components.map((c) => c.toJSON()),
        edited: m.editedAt?.toISOString() ?? null,
      })),
    });
  }

  writeFileSync(join(dir, 'messages.json'), JSON.stringify(dump, null, 2), 'utf-8');
}

export function snapshotStateMachine(
  runId: string,
  label: string,
  sessionIds: string[],
): void {
  const dir = artifactsDirFor(runId, label);
  mkdirSync(dir, { recursive: true });
  const dump = sessionIds.map((id) => ({
    sessionId: id,
    projection: stateMachine.getSnapshot(id),
    fullState: stateMachine.getState(id),
  }));
  writeFileSync(join(dir, 'state-machine.json'), JSON.stringify(dump, null, 2), 'utf-8');
}
