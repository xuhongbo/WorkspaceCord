import type { TextChannel } from 'discord.js';
import type { ProviderEvent } from '../../../packages/providers/src/types.ts';
import { getOutputPort } from '../../../packages/engine/src/output-port.ts';
import { DiscordE2EHarness } from '../harness/harness.ts';
import { assert, waitForMessageMatching } from '../harness/assertions.ts';

interface Case {
  terminalReason:
    | 'completed'
    | 'max_turns'
    | 'aborted'
    | 'rate_limited'
    | 'context_too_long'
    | 'model_error';
  success: boolean;
  expectLabel: string;
}

const CASES: Case[] = [
  { terminalReason: 'max_turns', success: false, expectLabel: '已达最大轮次' },
  { terminalReason: 'rate_limited', success: false, expectLabel: '触发速率限制' },
  { terminalReason: 'context_too_long', success: false, expectLabel: '上下文超长' },
  { terminalReason: 'aborted', success: false, expectLabel: '已中止' },
];

async function* makeResultStream(
  event: Extract<ProviderEvent, { type: 'result' }>,
): AsyncGenerator<ProviderEvent> {
  yield { type: 'text_delta', text: 'done.' };
  yield event;
}

async function runOne(
  harness: DiscordE2EHarness,
  channel: TextChannel,
  sessionId: string,
  provider: 'claude' | 'codex',
  c: Case,
): Promise<void> {
  const port = getOutputPort();
  const since = new Date();

  const result: Extract<ProviderEvent, { type: 'result' }> = {
    type: 'result',
    success: c.success,
    costUsd: 0.001,
    durationMs: 1234,
    numTurns: 2,
    errors: c.success ? [] : ['synthetic failure'],
    terminalReason: c.terminalReason,
  };

  await port.handleOutputStream(
    makeResultStream(result),
    channel,
    sessionId,
    false,
    'auto',
    provider,
  );

  try {
    await waitForMessageMatching(
      channel,
      (m) => m.content.includes(c.expectLabel),
      { since, timeoutMs: 12_000, label: `status line containing ${c.expectLabel}` },
    );
  } catch (err) {
    const dump = await channel.messages.fetch({ limit: 20 });
    const payload = Array.from(dump.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(
        (m) =>
          `  [${m.createdAt.toISOString()}] content=${JSON.stringify(m.content)} embeds=${m.embeds.length}`,
      )
      .join('\n');
    console.error(`[terminal-reason] ${provider}/${c.terminalReason} messages:\n${payload}`);
    throw err;
  }
}

export async function run(harness: DiscordE2EHarness): Promise<void> {
  for (const provider of ['claude', 'codex'] as const) {
    const channel = await harness.createScratchChannel({ label: `term-${provider}` });
    const session = await harness.createSession({ channel, provider });
    for (const c of CASES) {
      await runOne(harness, channel, session.id, provider, c);
    }
    assert(true, `terminal-reason ${provider} cases all passed`);
  }
}
