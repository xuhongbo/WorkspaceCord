import type { TextChannel } from 'discord.js';
import { getOutputPort } from '../../../packages/engine/src/output-port.ts';
import { DiscordE2EHarness } from '../harness/harness.ts';
import { assert, waitFor, waitForEmbedField, waitForEmbedFieldAbsent } from '../harness/assertions.ts';

async function fetchStatusCard(channel: TextChannel, messageId?: string) {
  if (!messageId) return null;
  return (await channel.messages.fetch(messageId).catch(() => null)) ?? null;
}

async function runOne(
  harness: DiscordE2EHarness,
  channel: TextChannel,
  sessionId: string,
  provider: 'claude' | 'codex',
): Promise<void> {
  const port = getOutputPort();

  await port.updateState(sessionId, {
    type: 'todo_updated',
    sessionId,
    source: provider,
    confidence: 'high',
    timestamp: Date.now(),
    metadata: {
      items: [
        { text: 'task A', completed: true },
        { text: 'task B', completed: false },
      ],
    },
  });

  const { getSessionView } = await import(
    '../../../packages/engine/src/session-context.ts'
  );
  const sv = await waitFor(
    async () => {
      const v = getSessionView(sessionId);
      return v?.statusCardMessageId ? v : null;
    },
    { timeoutMs: 8_000, label: 'status card message id' },
  );

  await waitForEmbedField(
    () => fetchStatusCard(channel, sv.statusCardMessageId),
    /^待办（1\/2）/,
    '☑ task A',
    { timeoutMs: 8_000, label: `待办 field populated (${provider})` },
  );
  await waitForEmbedField(
    () => fetchStatusCard(channel, sv.statusCardMessageId),
    /^待办/,
    '☐ task B',
  );

  await port.updateState(sessionId, {
    type: 'todo_updated',
    sessionId,
    source: provider,
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { items: [] },
  });

  await waitForEmbedFieldAbsent(
    () => fetchStatusCard(channel, sv.statusCardMessageId),
    /^待办/,
    { timeoutMs: 8_000, label: `待办 field absent when list empty (${provider})` },
  );
}

export async function run(harness: DiscordE2EHarness): Promise<void> {
  for (const provider of ['claude', 'codex'] as const) {
    const channel = await harness.createScratchChannel({ label: `todo-${provider}` });
    const session = await harness.createSession({ channel, provider });
    await runOne(harness, channel, session.id, provider);
    assert(true, `todo-list ${provider} passed`);
  }
}
