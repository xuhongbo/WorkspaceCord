import type { TextChannel } from 'discord.js';
import { stateMachine } from '../../../packages/state/src/state-machine.ts';
import {
  enqueueBatchApproval,
  getBatchApprovalCount,
} from '../../../packages/engine/src/output/batch-approval-store.ts';
import { getOutputPort } from '../../../packages/engine/src/output-port.ts';
import { handleAgent } from '../../../packages/bot/src/command-handlers.ts';
import { DiscordE2EHarness } from '../harness/harness.ts';
import { lastReplyText, makeChatInputInteraction } from '../harness/fake-interaction.ts';
import { assert, waitFor, waitForEmbedField } from '../harness/assertions.ts';

async function fetchStatusCard(channel: TextChannel, messageId?: string) {
  if (!messageId) return null;
  return (await channel.messages.fetch(messageId).catch(() => null)) ?? null;
}

function callAgentBatch(harness: DiscordE2EHarness, channel: TextChannel, action: string) {
  const interaction = makeChatInputInteraction({
    commandName: 'agent',
    subcommand: 'batch',
    stringOptions: [{ name: 'action', value: action }],
    env: {
      channel,
      guild: harness.guild,
      user: harness.bot.user ?? undefined,
    },
  });
  return { interaction, run: handleAgent(interaction) };
}

async function seedPendingRequests(
  sessionId: string,
  count: number,
): Promise<Array<Promise<string>>> {
  const port = getOutputPort();
  const promises: Array<Promise<string>> = [];
  for (let i = 0; i < count; i++) {
    const gateId = `batch-test-${sessionId}-${i}`;
    const timestamp = Date.now();
    stateMachine.enqueuePendingApproval(sessionId, {
      gateId,
      toolName: `Write-${i}`,
      detail: `write file ${i}`,
      timestamp,
    });
    promises.push(
      new Promise<string>((resolve) => {
        enqueueBatchApproval(sessionId, {
          gateId,
          toolUseID: `tu-${i}`,
          toolName: `Write-${i}`,
          detail: `write file ${i}`,
          timestamp,
          resolve,
        });
      }),
    );
  }
  await port.updateState(sessionId, {
    type: 'batch_approval_changed',
    sessionId,
    source: 'claude',
    confidence: 'high',
    timestamp: Date.now(),
    metadata: {
      enabled: true,
      pendingApprovals: stateMachine.getSnapshot(sessionId).pendingApprovals,
    },
  });
  return promises;
}

async function runOne(
  harness: DiscordE2EHarness,
  channel: TextChannel,
  sessionId: string,
): Promise<void> {
  const port = getOutputPort();

  // --- action: on -----------------------------------------------------------
  const on = callAgentBatch(harness, channel, 'on');
  await on.run;
  assert(
    lastReplyText(on.interaction).includes('已开启批量审批'),
    `on reply should mention 已开启批量审批, got: ${lastReplyText(on.interaction)}`,
  );
  assert(
    stateMachine.getSnapshot(sessionId).batchApprovalMode === true,
    'batchApprovalMode should be true after action:on',
  );

  // --- seed 2 pending requests ---------------------------------------------
  const pending = await seedPendingRequests(sessionId, 2);
  assert(getBatchApprovalCount(sessionId) === 2, 'queue size should be 2');

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
      /^批量审批/,
      /Write-0/,
      { timeoutMs: 10_000, label: '批量审批 field with 2 pending' },
    );
  } catch (err) {
    const msg = await fetchStatusCard(channel, sv.statusCardMessageId);
    console.error(
      `[batch-approval] status card dump:`,
      JSON.stringify(
        msg?.embeds[0]?.toJSON() ?? { error: 'no embed' },
        null,
        2,
      ),
    );
    throw err;
  }

  // --- action: approve-all --------------------------------------------------
  const approveAll = callAgentBatch(harness, channel, 'approve-all');
  await approveAll.run;
  assert(
    lastReplyText(approveAll.interaction).includes('已批准 2 条'),
    `approve-all reply: ${lastReplyText(approveAll.interaction)}`,
  );
  const resolutions = await Promise.all(pending);
  assert(
    resolutions.every((r) => r === 'approve'),
    `all 2 pending should resolve to approve, got: ${resolutions.join(',')}`,
  );
  assert(getBatchApprovalCount(sessionId) === 0, 'queue should be drained');

  await waitForEmbedField(
    () => fetchStatusCard(channel, sv.statusCardMessageId),
    /^批量审批（0 待批）/,
    /队列为空/,
    { timeoutMs: 8_000, label: '批量审批 field shows empty queue after approve-all' },
  );

  // --- action: reject-all ---------------------------------------------------
  const pending2 = await seedPendingRequests(sessionId, 2);
  const rejectAll = callAgentBatch(harness, channel, 'reject-all');
  await rejectAll.run;
  const res2 = await Promise.all(pending2);
  assert(
    res2.every((r) => r === 'reject'),
    `reject-all should resolve with reject, got: ${res2.join(',')}`,
  );

  // --- action: off (with 1 pending — should auto-reject) --------------------
  const pending3 = await seedPendingRequests(sessionId, 1);
  const off = callAgentBatch(harness, channel, 'off');
  await off.run;
  assert(
    lastReplyText(off.interaction).includes('已关闭批量审批'),
    `off reply: ${lastReplyText(off.interaction)}`,
  );
  const res3 = await Promise.all(pending3);
  assert(res3[0] === 'reject', 'off should reject remaining approvals');
  assert(
    stateMachine.getSnapshot(sessionId).batchApprovalMode === false,
    'batchApprovalMode should be false after action:off',
  );
}

export async function run(harness: DiscordE2EHarness): Promise<void> {
  // batch approval is provider-agnostic; one run with claude is sufficient
  const channel = await harness.createScratchChannel({ label: 'batch' });
  const session = await harness.createSession({ channel, provider: 'claude' });
  await runOne(harness, channel, session.id);
  assert(true, 'batch-approval passed');
}
