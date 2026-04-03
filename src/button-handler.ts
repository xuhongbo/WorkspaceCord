import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';

type SessionChannel = TextChannel | AnyThreadChannel;
type EditableRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;
type ComponentLike = {
  customId?: string;
  label?: string;
  options?: Array<{ label: string; description?: string; value: string }>;
};

function asComponentLike(component: unknown): ComponentLike {
  return (component || {}) as ComponentLike;
}
import { config } from './config.ts';
import * as sessions from './thread-manager.ts';
import {
  getExpandableContent,
  makeModeButtons,
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
} from './output-handler.ts';
import { executeSessionContinue, executeSessionPrompt } from './session-executor.ts';
import { updateSessionState } from './panel-adapter.ts';
import {
  acquireCleanupLock,
  deleteCleanupRequest,
  getCleanupRequest,
  releaseCleanupLock,
} from './agent-cleanup-request-store.ts';
import { archiveSessionsById } from './session-housekeeping.ts';
import { isUserAllowed, truncate } from './utils.ts';
import { gateCoordinator } from './state/gate-coordinator.ts';

async function resolveAwaitingHumanIfNeeded(sessionId: string): Promise<void> {
  const session = sessions.getSession(sessionId);
  if (!session?.currentInteractionMessageId) {
    return;
  }

  sessions.updateSession(sessionId, {
    humanResolved: true,
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

function renderCleanupResultMessage(result: {
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

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    console.warn(`[ButtonHandler] Unauthorized button press by user ${interaction.user.id}: ${interaction.customId}`);
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  // Stop button
  if (customId.startsWith('stop:')) {
    const sessionId = customId.slice(5);
    const stopped = sessions.abortSession(sessionId);
    console.log(`[ButtonHandler] Stop button pressed by ${interaction.user.tag} — session ${sessionId} ${stopped ? 'stopped' : 'was not generating'}`);
    await interaction.reply({
      content: stopped ? 'Generation stopped.' : 'Session was not generating.',
      ephemeral: true,
    });
    return;
  }

  // Awaiting human buttons
  if (customId.startsWith('awaiting_human:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const turn = parseInt(parts[2], 10);
    const action = parts[3] as 'approve' | 'deny';

    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: '会话不存在', ephemeral: true });
      return;
    }

    // 检查轮次是否匹配
    if (session.currentTurn !== turn) {
      await interaction.reply({ content: '此请求已过期（轮次不匹配）', ephemeral: true });
      return;
    }

    // 检查消息 ID 是否匹配
    if (session.currentInteractionMessageId && interaction.message.id !== session.currentInteractionMessageId) {
      await interaction.reply({ content: '此请求已过期（消息不匹配）', ephemeral: true });
      return;
    }

    // 检查是否已被处理
    if (session.humanResolved) {
      await interaction.reply({ content: '已被其他人处理', ephemeral: true });
      return;
    }

    // 获取当前交互卡对应的活跃门控
    const activeGate = session.activeHumanGateId
      ? gateCoordinator.getGate(session.activeHumanGateId)
      : gateCoordinator.getActiveGateForSession(sessionId);
    if (!activeGate) {
      await interaction.reply({ content: '未找到活跃的门控记录', ephemeral: true });
      return;
    }

    // 尝试通过 Discord 解决门控（CAS 更新）
    const result = await gateCoordinator.resolveFromDiscord(
      activeGate.id,
      action === 'approve' ? 'approve' : 'reject',
    );

    if (!result.success) {
      await interaction.reply({
        content: `处理失败: ${result.message || '未知错误'}`,
        ephemeral: true
      });
      return;
    }

    // 更新会话状态
    sessions.updateSession(sessionId, {
      humanResolved: true,
      currentInteractionMessageId: undefined,
      activeHumanGateId: undefined,
    });

    // 更新交互卡
    await interaction.update({
      components: [],
      embeds: interaction.message.embeds.map((e) => ({
        ...e,
        footer: {
          text: `${interaction.user.tag} ${action === 'approve' ? '已批准' : '已拒绝'} - ${new Date().toLocaleTimeString()}`
        },
      })),
    });

    if (result.handledByReceipt) {
      return;
    }

    // 根据操作继续或停止
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
          ephemeral: true
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
    return;
  }

  // Continue button
  if (customId.startsWith('continue:')) {
    const sessionId = customId.slice(9);
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    if (session.isGenerating) {
      await interaction.reply({ content: 'Session is already generating.', ephemeral: true });
      return;
    }
    console.log(`[ButtonHandler] Continue button pressed for session ${sessionId}`);
    await interaction.deferReply();
    try {
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply('Continuing...');
      await executeSessionContinue(session, channel);
      console.log(`[ButtonHandler] Session ${sessionId} continued successfully`);
    } catch (err: unknown) {
      console.error(`[ButtonHandler] Error continuing session ${sessionId}: ${(err as Error).message}`);
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  // Expand button
  if (customId.startsWith('expand:')) {
    const contentId = customId.slice(7);
    const content = getExpandableContent(contentId);
    if (!content) {
      await interaction.reply({ content: 'Content expired.', ephemeral: true });
      return;
    }
    const display = truncate(content, 1950);
    await interaction.reply({ content: `\`\`\`\n${display}\n\`\`\``, ephemeral: true });
    return;
  }

  // Deprecated: option, pick, submit-answers, answer, confirm — all replaced by interaction cards
  if (
    customId.startsWith('option:') ||
    customId.startsWith('pick:') ||
    customId.startsWith('submit-answers:') ||
    customId.startsWith('answer:') ||
    customId.startsWith('confirm:')
  ) {
    await interaction.reply({
      content: '⚠️ 此交互方式已废弃，请使用最新的交互卡',
      ephemeral: true,
    });
    return;
  }

  if (customId.startsWith('cleanup:cancel:')) {
    const requestId = customId.slice('cleanup:cancel:'.length);
    const request = getCleanupRequest(requestId);
    if (!request) {
      await interaction.reply({
        content: '这次清理请求已失效，请重新执行 /agent cleanup。',
        ephemeral: true,
      });
      return;
    }
    if (request.userId !== interaction.user.id) {
      await interaction.reply({
        content: '只有发起这次清理的人可以确认或取消。',
        ephemeral: true,
      });
      return;
    }
    deleteCleanupRequest(requestId);
    await interaction.update({
      content: '本次批量清理已取消。',
      components: [],
    });
    return;
  }

  if (customId.startsWith('cleanup:confirm:')) {
    const requestId = customId.slice('cleanup:confirm:'.length);
    const request = getCleanupRequest(requestId);
    if (!request) {
      await interaction.reply({
        content: '这次清理请求已失效，请重新执行 /agent cleanup。',
        ephemeral: true,
      });
      return;
    }
    if (request.userId !== interaction.user.id) {
      await interaction.reply({
        content: '只有发起这次清理的人可以确认或取消。',
        ephemeral: true,
      });
      return;
    }
    if (!interaction.guild) {
      await interaction.reply({ content: 'Guild context required.', ephemeral: true });
      return;
    }
    if (!acquireCleanupLock(request.categoryId)) {
      await interaction.reply({
        content: '当前项目正在执行批量清理，请稍后再试。',
        ephemeral: true,
      });
      return;
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
      await interaction.editReply({
        content: renderCleanupResultMessage(result),
        components: [],
      });
    } finally {
      releaseCleanupLock(request.categoryId);
    }
    return;
  }

  // Mode switch buttons
  if (customId.startsWith('mode:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const newMode = parts[2] as 'auto' | 'plan' | 'normal' | 'monitor';
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    const oldMode = session.mode;
    sessions.setMode(sessionId, newMode);
    console.log(`[ButtonHandler] Mode switched for session ${sessionId}: ${oldMode} → ${newMode}`);
    const labels: Record<string, string> = {
      auto: '⚡ Auto — full autonomy',
      plan: '📋 Plan — plans before changes',
      normal: '🛡️ Normal — asks before destructive ops',
      monitor: '🧠 Monitor — keeps steering toward completion',
    };
    await interaction.reply({
      content: `Mode switched to **${labels[newMode]}**`,
      ephemeral: true,
    });
    try {
      const original = interaction.message;
      const session = sessions.getSession(sessionId);
      const updatedComponents: EditableRow[] = original.components.map((row) => {
        if (!('components' in row)) return row as unknown as EditableRow;
        const first = asComponentLike(row.components?.[0]);
        if (first?.customId?.startsWith('mode:')) {
          return makeModeButtons(sessionId, newMode, session?.claudePermissionMode) as EditableRow;
        }
        return row as unknown as EditableRow;
      });
      await original.edit({ components: updatedComponents });
    } catch {
      /* message may be deleted */
    }
    return;
  }

  await interaction.reply({ content: 'Unknown button.', ephemeral: true });
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  const customId = interaction.customId;

  if (customId.startsWith('pick-select:')) {
    const parts = customId.split(':');
    const sessionId = parts[1];
    const questionIndex = parseInt(parts[2], 10);
    const selected = interaction.values[0];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
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
        const menu = new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder(`Selected: ${selected.slice(0, 80)}`);
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
      content: `Selected for Q${questionIndex + 1}: **${truncate(selected, 100)}** (${answeredCount}/${totalQuestions} answered)`,
      ephemeral: true,
    });
    return;
  }

  if (customId.startsWith('answer-select:')) {
    const afterPrefix = customId.slice(14);
    const sessionId = afterPrefix.includes(':') ? afterPrefix.split(':')[0] : afterPrefix;
    const selected = interaction.values[0];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      await resolveAwaitingHumanIfNeeded(sessionId);
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Answered: **${truncate(selected, 100)}**`);
      await executeSessionPrompt(session, channel, selected);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  if (customId.startsWith('select:')) {
    const sessionId = customId.slice(7);
    const selected = interaction.values[0];
    const session = sessions.getSession(sessionId);
    if (!session) {
      await interaction.reply({ content: 'Session not found.', ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      await resolveAwaitingHumanIfNeeded(sessionId);
      const channel = interaction.channel as SessionChannel;
      await interaction.editReply(`Selected: ${truncate(selected, 100)}`);
      await executeSessionPrompt(session, channel, selected);
    } catch (err: unknown) {
      await interaction.editReply(`Error: ${(err as Error).message}`);
    }
    return;
  }

  await interaction.reply({ content: 'Unknown selection.', ephemeral: true });
}
