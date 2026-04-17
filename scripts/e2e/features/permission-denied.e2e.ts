import type { TextChannel } from 'discord.js';
import { getOutputPort } from '../../../packages/engine/src/output-port.ts';
import { stateMachine } from '../../../packages/state/src/state-machine.ts';
import { DiscordE2EHarness } from '../harness/harness.ts';
import {
  assert,
  waitFor,
  waitForEmbedField,
  waitForMessageMatching,
} from '../harness/assertions.ts';

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
  const since = new Date();

  await port.updateState(sessionId, {
    type: 'permission_denied',
    sessionId,
    source: provider,
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { toolName: 'Write', reason: 'test deny', source: 'user' },
  });

  port.queueDigest(sessionId, {
    kind: 'denied',
    text: `⛔ 权限拒绝：Write — test deny`,
  });
  await port.flushDigest(sessionId);

  await waitForMessageMatching(
    channel,
    (m) => {
      if (m.content.includes('⛔ 权限拒绝：Write')) return true;
      return m.embeds.some((e) => {
        const blob = `${e.title ?? ''} ${e.description ?? ''} ${e.fields.map((f) => `${f.name} ${f.value}`).join(' ')}`;
        return blob.includes('⛔ 权限拒绝：Write');
      });
    },
    { since, timeoutMs: 8_000, label: `digest ⛔ message (${provider})` },
  );

  const { getSessionView } = await import(
    '../../../packages/engine/src/session-context.ts'
  );
  const sv = await waitFor(
    async () => {
      const v = getSessionView(sessionId);
      return v?.statusCardMessageId ? v : null;
    },
    { timeoutMs: 8_000, label: 'status card ready' },
  );

  try {
    await waitForEmbedField(
      () => fetchStatusCard(channel, sv.statusCardMessageId),
      '最近拒绝',
      '⛔ Write',
      { timeoutMs: 10_000, label: `最近拒绝 field (${provider})` },
    );
  } catch (err) {
    const msg = await fetchStatusCard(channel, sv.statusCardMessageId);
    console.error(
      `[permission-denied] ${provider} status card dump:`,
      JSON.stringify(msg?.embeds[0]?.toJSON() ?? { error: 'no embed' }, null, 2),
    );
    const snap = stateMachine.getSnapshot(sessionId);
    console.error(
      `[permission-denied] ${provider} state snap recentPermissionDenials=`,
      JSON.stringify(snap.recentPermissionDenials, null, 2),
    );
    throw err;
  }

  for (let i = 0; i < 6; i++) {
    await port.updateState(sessionId, {
      type: 'permission_denied',
      sessionId,
      source: provider,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { toolName: `Tool-${i}`, reason: `reason-${i}`, source: 'user' },
    });
  }

  const snap = stateMachine.getSnapshot(sessionId);
  assert(
    (snap.recentPermissionDenials?.length ?? 0) === 5,
    `ring buffer should cap at 5, got ${snap.recentPermissionDenials?.length}`,
  );
  assert(
    snap.recentPermissionDenials![0].toolName === 'Tool-5',
    `newest entry should be Tool-5, got ${snap.recentPermissionDenials![0].toolName}`,
  );
}

export async function run(harness: DiscordE2EHarness): Promise<void> {
  for (const provider of ['claude', 'codex'] as const) {
    const channel = await harness.createScratchChannel({ label: `deny-${provider}` });
    const session = await harness.createSession({ channel, provider });
    await runOne(harness, channel, session.id, provider);
    assert(true, `permission-denied ${provider} passed`);
  }
}
