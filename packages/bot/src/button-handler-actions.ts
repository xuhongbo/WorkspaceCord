import {
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { SessionChannel } from './discord-types.ts';
import { config, truncate } from '@workspacecord/core';
import { updateSession, abortSession, setMode } from '@workspacecord/engine/session-registry';
import { getSessionView } from '@workspacecord/engine/session-context';
import {
  getExpandableContent,
  makeModeButtons,
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
} from './output-handler.ts';
import { executeSessionContinue, executeSessionPrompt } from '@workspacecord/engine/session-executor';
import { updateSessionState, getSessionProjection } from './panel-adapter.ts';
import {
  acquireCleanupLock,
  deleteCleanupRequest,
  getCleanupRequest,
  releaseCleanupLock,
} from '@workspacecord/engine/agent-cleanup-request-store';
import { archiveSessionsById } from './session-housekeeping.ts';
import { gateCoordinator, stateMachine } from '@workspacecord/state';
type EditableRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;
type ComponentLike = {
  customId?: string;
  label?: string;
  options?: Array<{ label: string; description?: string; value: string }>;
};

function asComponentLike(component: unknown): ComponentLike {
  return (component || {}) as ComponentLike;
}

export async function resolveAwaitingHumanIfNeeded(sessionId: string): Promise<void> {
  const session = getSessionView(sessionId);
  if (!session?.currentInteractionMessageId) {
    return;
  }

  // P2:humanResolved 经 StateMachine(persister 会同步到 session),这里只清 interaction 消息 ID
  updateSession(sessionId, {
    currentInteractionMessageId: undefined,
  });
  await updateSessionState(sessionId, {
    type: 'human_resolved',
    sessionId,
    source: session.provider === 'codex' ? 'codex' : 'claude',
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { source: 'answer' },
  });
}

export function renderCleanupResultMessage(result: {
  archivedSessions: number;
  skippedGenerating: number;
  missingSessions: number;
  failed: Array<{ sessionId: string; channelId?: string; message: string }>;
}): string {
  const lines = [
    '批量清理完成',
    '',
    `- 已归档：${result.archivedSessions}`,
    `- 跳过进行中：${result.skippedGenerating}`,
    `- 缺失：${result.missingSessions}`,
    `- 失败：${result.failed.length}`,
  ];

  if (result.failed.length > 0) {
    lines.push('', '失败明细：');
    lines.push(
      ...result.failed.map((item) => `- ${item.channelId ? `<#${item.channelId}> ` : ''}${item.sessionId}：${item.message}`),
    );
  }

  return lines.join('\n');
}

export async function handleStopButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith('stop:')) return false;
  const sessionId = interaction.customId.slice(5);
  const stopped = abortSession(sessionId);
  console.log(`[ButtonHandler] Stop button pressed by ${interaction.user.tag} — session ${sessionId} ${stopped ? 'stopped' : 'was not generating'}`);
  await interaction.reply({
    content: stopped ? '已停止生成。' : '会话未在执行中。',
    ephemeral: true,
  });
  return true;
}

export async function handleAwaitingHumanButton(interaction: ButtonInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith('awaiting_human:')) return false;

  const parts = customId.split(':');
  const sessionId = parts[1];
  const turn = parseInt(parts[2], 10);
  const action = parts[3] as 'approve' | 'deny';

  const session = getSessionView(sessionId);
  if (!session) {
    await interaction.reply({ content: '会话不存在', ephemeral: true });
    return true;
  }
  const projection = getSessionProjection(sessionId);
  if (projection.turn !== turn) {
    await interaction.reply({ content: '此请求已过期（轮次不匹配）', ephemeral: true });
    return true;
  }
  if (session.currentInteractionMessageId && interaction.message.id !== session.currentInteractionMessageId) {
    await interaction.reply({ content: '此请求已过期（消息不匹配）', ephemeral: true });
    return true;
  }
  if (projection.humanResolved) {
    await interaction.reply({ content: '已被其他人处理', ephemeral: true });
    return true;
  }

  const activeGate = session.activeHumanGateId
    ? gateCoordinator.getGate(session.activeHumanGateId)
    : gateCoordinator.getActiveGateForSession(sessionId);
  if (!activeGate) {
    await interaction.reply({ content: '未找到活跃的门控记录', ephemeral: true });
    return true;
  }

  const result = await gateCoordinator.resolveFromDiscord(
    activeGate.id,
    action === 'approve' ? 'approve' : 'reject',
  );

  if (!result.success) {
    await interaction.reply({
      content: `处理失败: ${result.message || '未知错误'}`,
      ephemeral: true,
    });
    return true;
  }

  // P2:humanResolved 由 StateMachine.setHumanResolved → persister 回写
  stateMachine.setHumanResolved(sessionId, true);
  updateSession(sessionId, {
    currentInteractionMessageId: undefined,
    activeHumanGateId: undefined,
  });

  await interaction.update({
    components: [],
    embeds: interaction.message.embeds.map((e) => ({
      ...e,
      footer: {
        text: `${interaction.user.tag} ${action === 'approve' ? '已批准' : '已拒绝'} - ${new Date().toLocaleTimeString()}`,
      },
    })),
  });

  if (result.handledByReceipt) {
    return true;
  }

  if (action === 'approve') {
    console.log(`[ButtonHandler] User ${interaction.user.tag} approved gate for session ${sessionId}`);
    await updateSessionState(sessionId, {
      type: 'human_resolved',
      sessionId,
      source: session.provider === 'codex' ? 'codex' : 'claude',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { action: 'approve' },
    });
    try {
      const channel = interaction.channel as SessionChannel;
      await executeSessionContinue(session, channel);
    } catch (err: unknown) {
      await interaction.followUp({
        content: `继续会话失败: ${(err as Error).message}`,
        ephemeral: true,
      });
    }
  } else {
    console.log(`[ButtonHandler] User ${interaction.user.tag} rejected gate for session ${sessionId}`);
    await updateSessionState(sessionId, {
      type: 'session_idle',
      sessionId,
      source: session.provider === 'codex' ? 'codex' : 'claude',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { action: 'reject' },
    });
    await interaction.followUp({
      content: '已拒绝本轮请求，状态已回落到待命。',
      ephemeral: true,
    });
  }
  return true;
}

export async function handleContinueButton(interaction: ButtonInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith('continue:')) return false;
  const sessionId = customId.slice(9);
  const session = getSessionView(sessionId);
  if (!session) {
    await interaction.reply({ content: '会话不存在。', ephemeral: true });
    return true;
  }
  if (session.isGenerating) {
    await interaction.reply({ content: '会话正在执行中。', ephemeral: true });
    return true;
  }
  console.log(`[ButtonHandler] Continue button pressed for session ${sessionId}`);
  await interaction.deferReply();
  try {
    const channel = interaction.channel as SessionChannel;
    await interaction.editReply('继续中...');
    await executeSessionContinue(session, channel);
    console.log(`[ButtonHandler] Session ${sessionId} continued successfully`);
  } catch (err: unknown) {
    console.error(`[ButtonHandler] Error continuing session ${sessionId}: ${(err as Error).message}`);
    await interaction.editReply(`Error: ${(err as Error).message}`);
  }
  return true;
}

export async function handleExpandButton(interaction: ButtonInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith('expand:')) return false;
  const contentId = customId.slice(7);
  const content = getExpandableContent(contentId);
  if (!content) {
    await interaction.reply({ content: '内容已过期。', ephemeral: true });
    return true;
  }
  const display = truncate(content, 1950);
  await interaction.reply({ content: `\`\`\`\n${display}\n\`\`\``, ephemeral: true });
  return true;
}

export async function handleDeprecatedInteractionButton(interaction: ButtonInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!(customId.startsWith('option:') || customId.startsWith('pick:') || customId.startsWith('submit-answers:') || customId.startsWith('answer:') || customId.startsWith('confirm:'))) {
    return false;
  }
  await interaction.reply({
    content: '⚠️ 此交互方式已废弃，请使用最新的交互卡',
    ephemeral: true,
  });
  return true;
}

export async function handleCleanupButtons(interaction: ButtonInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (customId.startsWith('cleanup:cancel:')) {
    const requestId = customId.slice('cleanup:cancel:'.length);
    const request = getCleanupRequest(requestId);
    if (!request) {
      await interaction.reply({ content: '这次清理请求已失效，请重新执行 /agent cleanup。', ephemeral: true });
      return true;
    }
    if (request.userId !== interaction.user.id) {
      await interaction.reply({ content: '只有发起这次清理的人可以确认或取消。', ephemeral: true });
      return true;
    }
    deleteCleanupRequest(requestId);
    await interaction.update({ content: '本次批量清理已取消。', components: [] });
    return true;
  }

  if (customId.startsWith('cleanup:confirm:')) {
    const requestId = customId.slice('cleanup:confirm:'.length);
    const request = getCleanupRequest(requestId);
    if (!request) {
      await interaction.reply({ content: '这次清理请求已失效，请重新执行 /agent cleanup。', ephemeral: true });
      return true;
    }
    if (request.userId !== interaction.user.id) {
      await interaction.reply({ content: '只有发起这次清理的人可以确认或取消。', ephemeral: true });
      return true;
    }
    if (!interaction.guild) {
      await interaction.reply({ content: '需要服务器上下文。', ephemeral: true });
      return true;
    }
    if (!acquireCleanupLock(request.categoryId)) {
      await interaction.reply({ content: '当前项目正在执行批量清理，请稍后再试。', ephemeral: true });
      return true;
    }

    await interaction.deferUpdate();
    try {
      console.log(`[ButtonHandler] Cleanup confirmed by ${interaction.user.tag} — archiving ${request.candidateSessionIds.length} sessions`);
      const result = await archiveSessionsById(
        interaction.guild,
        request.candidateSessionIds,
        'Bulk cleanup from Discord command',
      );
      deleteCleanupRequest(requestId);
      await interaction.editReply({ content: renderCleanupResultMessage(result), components: [] });
    } finally {
      releaseCleanupLock(request.categoryId);
    }
    return true;
  }

  return false;
}

export async function handleModeButton(interaction: ButtonInteraction): Promise<boolean> {
  const customId = interaction.customId;
  if (!customId.startsWith('mode:')) return false;
  const parts = customId.split(':');
  const sessionId = parts[1];
  const newMode = parts[2] as 'auto' | 'plan' | 'normal' | 'monitor';
  const session = getSessionView(sessionId);
  if (!session) {
    await interaction.reply({ content: '会话不存在。', ephemeral: true });
    return true;
  }
  const oldMode = session.mode;
  setMode(sessionId, newMode);
  console.log(`[ButtonHandler] Mode switched for session ${sessionId}: ${oldMode} → ${newMode}`);
  const labels: Record<string, string> = {
    auto: '⚡ 自动模式 — 完全自主',
    plan: '📋 计划模式 — 变更前先规划',
    normal: '🛡️ 普通模式 — 破坏性操作前确认',
    monitor: '🧠 监控模式 — 持续引导直到完成',
  };
  await interaction.reply({ content: `已切换至 **${labels[newMode]}**`, ephemeral: true });
  try {
    const original = interaction.message;
    const liveSession = getSessionView(sessionId);
    const updatedComponents: EditableRow[] = original.components.map((row) => {
      if (!('components' in row)) return row as unknown as EditableRow;
      const first = asComponentLike(row.components?.[0]);
      if (first?.customId?.startsWith('mode:')) {
        return makeModeButtons(sessionId, newMode, liveSession?.claudePermissionMode) as EditableRow;
      }
      return row as unknown as EditableRow;
    });
    await original.edit({ components: updatedComponents });
  } catch {
    /* message may be deleted */
  }
  return true;
}

export async function handleSelectMenuAction(interaction: StringSelectMenuInteraction): Promise<boolean> {
  const customId = interaction.customId;

  if (customId.startsWith('pick-select:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const questionIndex = parseInt(parts[2], 10);
    const selected = interaction.values[0];
    const session = getSessionView(sessionId);
    if (!session) {
      await interaction.reply({ content: '会话不存在。', ephemeral: true });
      return true;
    }
    setPendingAnswer(sessionId, questionIndex, selected);
    const totalQuestions = getQuestionCount(sessionId);
    const pending = getPendingAnswers(sessionId);
    const answeredCount = pending?.size || 0;

    try {
      const original = interaction.message;
      const updatedComponents: EditableRow[] = original.components.map((row) => {
        if (!('components' in row)) return row as unknown as EditableRow;
        const comp = asComponentLike(row.components?.[0]);
        if (comp?.customId !== customId) return row as unknown as EditableRow;
        const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(`已选择：${selected.slice(0, 80)}`);
        for (const opt of comp.options || []) {
          menu.addOptions({
            label: opt.label,
            description: opt.description || undefined,
            value: opt.value,
            default: opt.value === selected,
          });
        }
        return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
      });
      await original.edit({ components: updatedComponents });
    } catch {
      /* message may be deleted */
    }

    await interaction.reply({
      content: `问题 ${questionIndex + 1} 已选：**${truncate(selected, 100)}**（${answeredCount}/${totalQuestions} 已回答）`,
      ephemeral: true,
    });
    return true;
  }

  if (customId.startsWith('answer-select:')) {
    const afterPrefix = customId.slice(14);
    const sessionId = afterPrefix.includes(':') ? afterPrefix.split(':')[0] : afterPrefix;
    const selected = interaction.values[0];
    const session = getSessionView(sessionId);
    if (!session) {
      await interaction.reply({ content: '会话不存在。', ephemeral: true });
      return true;
    }
    await interaction.deferReply();
    try {
      await resolveAwaitingHumanIfNeeded(sessionId);
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`已回答：**${truncate(selected, 100)}**`);
      await executeSessionPrompt(session, channel, selected);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return true;
  }

  if (customId.startsWith('select:')) {
    const sessionId = customId.slice(7);
    const selected = interaction.values[0];
    const session = getSessionView(sessionId);
    if (!session) {
      await interaction.reply({ content: '会话不存在。', ephemeral: true });
      return true;
    }
    await interaction.deferReply();
    try {
      await resolveAwaitingHumanIfNeeded(sessionId);
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`已选择：${truncate(selected, 100)}`);
      await executeSessionPrompt(session, channel, selected);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return true;
  }

  return false;
}
