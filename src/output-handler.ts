import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type TextChannel,
  type AnyThreadChannel,
  type Message,
} from 'discord.js';

type SessionChannel = TextChannel | AnyThreadChannel;
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import type { ProviderEvent, ProviderName } from './providers/types.ts';
import {
  truncate,
  detectNumberedOptions,
  detectYesNoPrompt,
  isAbortError,
} from './utils.ts';
import type { ExpandableContent } from './types.ts';
import {
  renderCommandExecutionEmbed,
  renderFileChangesEmbed,
  renderReasoningEmbed,
  renderCodexTodoListEmbed,
} from './codex-renderer.ts';
import { getSession } from './thread-manager.ts';
import * as sessions from './thread-manager.ts';
import { buildDeliveryPlan } from './discord/delivery-policy.ts';
import { deliver } from './discord/delivery.ts';
import {
  initializeSessionPanel,
  updateSessionState,
  handleResultEvent,
  handleAwaitingHuman,
  queueDigest,
  flushDigest,
} from './panel-adapter.ts';

// In-memory store for expandable content (with TTL cleanup)
const expandableStore = new Map<string, ExpandableContent>();
let expandCounter = 0;

const pendingAnswersStore = new Map<string, Map<number, string>>();
const questionCountStore = new Map<string, number>();

export function setPendingAnswer(sessionId: string, questionIndex: number, answer: string): void {
  if (!pendingAnswersStore.has(sessionId)) {
    pendingAnswersStore.set(sessionId, new Map());
  }
  pendingAnswersStore.get(sessionId)!.set(questionIndex, answer);
}

export function getPendingAnswers(sessionId: string): Map<number, string> | undefined {
  return pendingAnswersStore.get(sessionId);
}

export function clearPendingAnswers(sessionId: string): void {
  pendingAnswersStore.delete(sessionId);
  questionCountStore.delete(sessionId);
}

export function getQuestionCount(sessionId: string): number {
  return questionCountStore.get(sessionId) || 0;
}

// Clean up expired expandable content every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    const TTL = 10 * 60 * 1000;
    for (const [key, val] of expandableStore) {
      if (now - val.createdAt > TTL) expandableStore.delete(key);
    }
  },
  5 * 60 * 1000,
);

export function getExpandableContent(id: string): string | undefined {
  return expandableStore.get(id)?.content;
}

function storeExpandable(content: string): string {
  const id = `exp_${++expandCounter}`;
  expandableStore.set(id, { content, createdAt: Date.now() });
  return id;
}

function makeStopButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${sessionId}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger),
  );
}

function makeOptionButtons(
  sessionId: string,
  options: string[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const maxOptions = Math.min(options.length, 10);
  for (let i = 0; i < maxOptions; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const chunk = options.slice(i, i + 5);
    for (let j = 0; j < chunk.length; j++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`option:${sessionId}:${i + j}`)
          .setLabel(truncate(chunk[j], 80))
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return rows;
}

export function makeModeButtons(
  sessionId: string,
  currentMode: string,
  claudePermissionMode?: 'bypass' | 'normal',
): ActionRowBuilder<ButtonBuilder> {
  const modes = [
    { id: 'auto', label: '⚡ 自动模式' },
    { id: 'plan', label: '📋 计划模式' },
    { id: 'normal', label: '🛡️ 普通模式' },
    { id: 'monitor', label: '🧠 监控模式' },
  ];

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const m of modes) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mode:${sessionId}:${m.id}`)
        .setLabel(m.label)
        .setStyle(m.id === currentMode ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(m.id === currentMode),
    );
  }

  // Add Claude permission mode indicator if applicable
  const effectiveClaudePermissionMode = resolveEffectiveClaudePermissionMode(
    currentMode,
    claudePermissionMode,
  );
  if (effectiveClaudePermissionMode) {
    const permLabel = effectiveClaudePermissionMode === 'bypass' ? '⚡ 绕过权限' : '🛡️ 需要确认';
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-info:${sessionId}`)
        .setLabel(permLabel)
        .setStyle(
          effectiveClaudePermissionMode === 'bypass' ? ButtonStyle.Danger : ButtonStyle.Success,
        )
        .setDisabled(true),
    );
  }

  return row;
}

export function resolveEffectiveClaudePermissionMode(
  currentMode: string,
  claudePermissionMode?: 'bypass' | 'normal',
): 'bypass' | 'normal' | undefined {
  if (!claudePermissionMode) return undefined;
  return currentMode === 'auto' ? 'bypass' : claudePermissionMode;
}

function makeYesNoButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${sessionId}:yes`)
      .setLabel('Yes')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`confirm:${sessionId}:no`)
      .setLabel('No')
      .setStyle(ButtonStyle.Danger),
  );
}

function shouldSuppressCommandExecution(command: string): boolean {
  return command.toLowerCase().includes('total-recall');
}

const STATUS_EMOJI: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  deleted: '🗑️',
};

function renderTaskToolEmbed(action: string, dataJson: string): EmbedBuilder | null {
  try {
    const data = JSON.parse(dataJson);
    if (action === 'TaskCreate') {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📋 New Task')
        .setDescription(`**${data.subject || 'Untitled'}**`);
      if (data.description) {
        embed.addFields({ name: 'Details', value: truncate(data.description, 300) });
      }
      return embed;
    }
    if (action === 'TaskUpdate') {
      const emoji = STATUS_EMOJI[data.status] || '📋';
      const parts: string[] = [];
      if (data.status) parts.push(`${emoji} **${data.status}**`);
      if (data.subject) parts.push(data.subject);
      return new EmbedBuilder()
        .setColor(data.status === 'completed' ? 0x2ecc71 : 0xf39c12)
        .setTitle(`Task #${data.taskId || '?'} Updated`)
        .setDescription(parts.join(' — ') || 'Updated');
    }
    return null;
  } catch {
    return null;
  }
}

function renderTaskListEmbed(resultText: string): EmbedBuilder | null {
  if (!resultText.trim()) return null;
  let formatted = resultText;
  for (const [status, emoji] of Object.entries(STATUS_EMOJI)) {
    formatted = formatted.replaceAll(status, `${emoji} ${status}`);
  }
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Task Board')
    .setDescription(truncate(formatted, 4000));
}

function renderAskUserQuestion(
  questionsJson: string,
  sessionId: string,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} | null {
  try {
    const data = JSON.parse(questionsJson);
    const questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> = data.questions;
    if (!questions?.length) return null;

    const isMulti = questions.length > 1;
    if (isMulti) {
      clearPendingAnswers(sessionId);
      questionCountStore.set(sessionId, questions.length);
    }

    const embeds: EmbedBuilder[] = [];
    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
    const btnPrefix = isMulti ? 'pick' : 'answer';
    const selectPrefix = isMulti ? 'pick-select' : 'answer-select';

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(q.header || 'Question')
        .setDescription(q.question);

      if (q.options?.length) {
        if (q.options.length <= 4) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (let i = 0; i < q.options.length; i++) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`${btnPrefix}:${sessionId}:${qi}:${q.options[i].label}`)
                .setLabel(q.options[i].label.slice(0, 80))
                .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
          }
          components.push(row);
        } else {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`${selectPrefix}:${sessionId}:${qi}`)
            .setPlaceholder('Select an option...');
          for (const opt of q.options) {
            menu.addOptions({
              label: opt.label.slice(0, 100),
              description: opt.description?.slice(0, 100),
              value: opt.label,
            });
          }
          components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
        }
        const optionLines = q.options
          .map((o) => (o.description ? `**${o.label}** — ${o.description}` : `**${o.label}**`))
          .join('\n');
        embed.addFields({ name: 'Options', value: truncate(optionLines, 1000) });
      }
      embeds.push(embed);
    }

    if (isMulti) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`submit-answers:${sessionId}`)
            .setLabel('Submit Answers')
            .setStyle(ButtonStyle.Success),
        ),
      );
    }

    return { embeds, components };
  } catch {
    return null;
  }
}

/**
 * Detect repetitive patterns in text (e.g., "我来帮你查看最近的对话历史。" repeated 10+ times)
 */
function detectRepetition(text: string): { isRepetitive: boolean; cleanedText: string } {
  // Split by sentence-ending punctuation
  const sentences = text.split(/[。！？\n]+/).filter((s) => s.trim().length > 5);
  if (sentences.length < 3) return { isRepetitive: false, cleanedText: text };

  // Count sentence frequencies
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    const normalized = sentence.trim();
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  // Find most repeated sentence
  let maxCount = 0;
  let mostRepeated = '';
  for (const [sentence, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostRepeated = sentence;
    }
  }

  // If a sentence repeats 5+ times, it's likely a repetition bug
  if (maxCount >= 5) {
    // Keep only first 2 occurrences + add warning
    const parts = text.split(mostRepeated);
    const cleaned = parts.slice(0, 3).join(mostRepeated) + mostRepeated;
    return {
      isRepetitive: true,
      cleanedText: cleaned + `\n\n⚠️ *[检测到重复输出,已截断 ${maxCount - 2} 次重复]*`,
    };
  }

  return { isRepetitive: false, cleanedText: text };
}

/**
 * Serialized message editor — ensures only one Discord API call is in-flight
 * at a time, preventing duplicate messages from race conditions.
 */
class MessageStreamer {
  private _channel: SessionChannel;
  private _sessionId: string;
  private currentText = '';
  private transcriptText = '';
  private dirty = false;
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly INTERVAL = 400;

  constructor(channel: SessionChannel, sessionId: string) {
    this._channel = channel;
    this._sessionId = sessionId;
  }

  append(text: string, options: { persist?: boolean } = {}): void {
    this.currentText += text;
    if (options.persist !== false) {
      this.transcriptText += text;
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.INTERVAL);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.dirty) return;
    this.flushing = true;
    try {
      this.dirty = false;
      if (this.currentText.trim()) {
        const plan = buildDeliveryPlan({
          sessionId: this._sessionId,
          chatId: this._channel.id,
          text: this.currentText,
          files: [],
          mode: 'progress_update',
          policy: {
            textChunkLimit: config.textChunkLimit,
            chunkMode: config.chunkMode,
            replyToMode: config.replyToMode,
            ackReaction: config.ackReaction,
          },
        });
        await deliver(this._channel, plan);
      }
    } finally {
      this.flushing = false;
      if (this.dirty) this.scheduleFlush();
    }
  }

  async finalize(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (this.dirty) {
      this.dirty = false;
      const { cleanedText } = detectRepetition(this.currentText);
      this.currentText = cleanedText;
    }
  }

  async discard(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.currentText = '';
    this.dirty = false;
  }

  getText(): string {
    return this.transcriptText;
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export async function handleOutputStream(
  stream: AsyncGenerator<ProviderEvent>,
  channel: SessionChannel,
  sessionId: string,
  verbose = false,
  mode = 'auto',
  _provider: ProviderName = 'claude',
  options: { onEvent?: (event: ProviderEvent) => void } = {},
): Promise<{
  text: string;
  askedUser: boolean;
  askUserQuestionsJson?: string;
  hadError: boolean;
  success: boolean | null;
  commandCount: number;
  fileChangeCount: number;
  recentCommands: string[];
  changedFiles: string[];
}> {
  const streamer = new MessageStreamer(channel, sessionId);
  let lastToolName: string | null = null;
  let askedUser = false;
  let askUserQuestionsJson: string | undefined;
  let hadError = false;
  let success: boolean | null = null;
  let commandCount = 0;
  let fileChangeCount = 0;
  const recentCommands: string[] = [];
  const changedFiles: string[] = [];
  const pendingAttachments: string[] = [];
  let lastDigestFlushAt = Date.now();
  const session = sessions.getSession(sessionId);

  if (session) {
    await initializeSessionPanel(sessionId, channel, {
      statusCardMessageId: session.statusCardMessageId,
      initialTurn: Math.max(session.currentTurn || 0, 1),
      phase: mode === 'monitor' ? '执行中（监控）' : '执行中',
    });
    await updateSessionState(sessionId, {
      type: 'work_started',
      sessionId,
      source: session.provider === 'claude' ? 'claude' : 'codex',
      confidence: 'high',
      timestamp: Date.now(),
    });
  }

  try {
    for await (const event of stream) {
      options.onEvent?.(event);
      switch (event.type) {
        case 'text_delta': {
          streamer.append(event.text);
          break;
        }

        case 'ask_user': {
          askedUser = true;
          askUserQuestionsJson = event.questionsJson;
          await streamer.discard();
          if (session) {
            await updateSessionState(sessionId, {
              type: 'awaiting_human',
              sessionId,
              source: session.provider === 'claude' ? 'claude' : 'codex',
              confidence: 'high',
              timestamp: Date.now(),
              metadata: { detail: event.questionsJson },
            });
            await flushDigest(sessionId);
            await handleAwaitingHuman(sessionId, event.questionsJson, {
              source: session.provider === 'claude' ? 'claude' : 'codex',
            });
          }
          break;
        }

        case 'task': {
          await streamer.finalize();
          queueDigest(sessionId, { kind: 'tool', text: `任务工具：${event.action}` });
          lastToolName = event.action;
          break;
        }

        case 'task_started': {
          await streamer.finalize();
          queueDigest(sessionId, {
            kind: 'subagent',
            text: `子代理启动：${truncate(event.description, 80)}`,
          });
          break;
        }

        case 'task_progress': {
          if (event.summary) {
            queueDigest(sessionId, {
              kind: 'subagent',
              text: `子代理进展：${truncate(event.summary, 100)}`,
            });
          }
          break;
        }

        case 'task_done': {
          await streamer.finalize();
          queueDigest(sessionId, {
            kind: 'subagent',
            text: `子代理${event.status === 'completed' ? '完成' : '结束'}：${truncate(event.summary || 'No summary.', 100)}`,
          });
          break;
        }

        case 'web_search': {
          if (verbose) {
            queueDigest(sessionId, { kind: 'search', text: `检索：${truncate(event.query, 80)}` });
          }
          break;
        }

        case 'tool_start': {
          await streamer.finalize();
          queueDigest(sessionId, { kind: 'tool', text: `工具：${event.toolName}` });
          lastToolName = event.toolName;
          break;
        }

        case 'tool_result': {
          await streamer.finalize();
          if (verbose && event.result) {
            queueDigest(sessionId, {
              kind: 'tool',
              text: `工具结果：${truncate(lastToolName || event.toolName || 'tool', 60)}`,
            });
          }
          break;
        }

        case 'image_file': {
          if (existsSync(event.filePath)) {
            pendingAttachments.push(event.filePath);
          }
          break;
        }

        case 'command_execution': {
          commandCount++;
          if (recentCommands.length < 8) recentCommands.push(event.command);
          if (!shouldSuppressCommandExecution(event.command)) {
            queueDigest(sessionId, {
              kind: 'command',
              text: `命令：${truncate(event.command, 80)}${event.exitCode !== null ? `（退出码 ${event.exitCode}）` : ''}`,
            });
          }
          break;
        }

        case 'file_change': {
          fileChangeCount += event.changes.length;
          for (const change of event.changes) {
            if (!change.filePath) continue;
            if (changedFiles.includes(change.filePath)) continue;
            if (changedFiles.length >= 12) break;
            changedFiles.push(change.filePath);
          }
          queueDigest(sessionId, {
            kind: 'file',
            text: `文件变更：${event.changes.length} 个（最近：${truncate(changedFiles.slice(-3).join(', '), 120)}）`,
          });
          break;
        }

        case 'reasoning': {
          if (verbose) {
            queueDigest(sessionId, { kind: 'reasoning', text: `推理：${truncate(event.text, 100)}` });
          }
          break;
        }

        case 'todo_list': {
          queueDigest(sessionId, {
            kind: 'todo',
            text: `待办更新：${event.items.filter((item) => item.completed).length}/${event.items.length} 已完成`,
          });
          break;
        }

        case 'result': {
          success = event.success;
          const lastText = streamer.getText();
          const cost = event.costUsd.toFixed(4);
          const duration = event.durationMs
            ? `${(event.durationMs / 1000).toFixed(1)}s`
            : 'unknown';
          const turns = event.numTurns || 0;
          const modeLabel =
            (
              { auto: 'Auto', plan: 'Plan', normal: 'Normal', monitor: 'Monitor' } as Record<
                string,
                string
              >
            )[mode] || 'Auto';
          const statusLine = event.success
            ? `-# $${cost} | ${duration} | ${turns} turns | ${modeLabel}`
            : `-# Error | $${cost} | ${duration} | ${turns} turns`;

          streamer.append(`\n${statusLine}`, { persist: false });
          if (!event.success && event.errors.length) {
            streamer.append(`\n\`\`\`\n${event.errors.join('\n')}\n\`\`\``, { persist: false });
          }
          await streamer.finalize();
          if (session) {
            if (mode === 'monitor') {
              await flushDigest(sessionId);
              await updateSessionState(sessionId, {
                type: 'work_started',
                sessionId,
                source: session.provider === 'claude' ? 'claude' : 'codex',
                confidence: 'high',
                timestamp: Date.now(),
                metadata: {
                  phase: '等待监督判断',
                  summary: event.success ? '本轮执行结束，等待监督判断' : '本轮执行失败，等待监督判断',
                },
              });
            } else {
              await flushDigest(sessionId);
              await handleResultEvent(sessionId, event, lastText, [...pendingAttachments]);
            }
          }
          pendingAttachments.length = 0;
         break;
        }

        case 'error': {
          hadError = true;
          await streamer.finalize();
          queueDigest(sessionId, { kind: 'error', text: `错误：${truncate(event.message, 120)}` });
          if (session && mode !== 'monitor') {
            await flushDigest(sessionId);
            await updateSessionState(sessionId, {
              type: 'errored',
              sessionId,
              source: session.provider === 'claude' ? 'claude' : 'codex',
              confidence: 'high',
              timestamp: Date.now(),
              metadata: { errorMessage: event.message },
            });
          }
          break;
        }

        case 'session_init': {
          // Threads don't have topics; metadata is stored in session JSON only
          break;
        }
      }

      if (session && Date.now() - lastDigestFlushAt >= 15000) {
        await flushDigest(sessionId);
        lastDigestFlushAt = Date.now();
      }
    }
  } catch (err: unknown) {
    hadError = true;
    await streamer.finalize();
    if (!isAbortError(err)) {
      const errMsg = (err as Error).message || '';
      queueDigest(sessionId, { kind: 'error', text: `异常：${truncate(errMsg, 120)}` });
      if (session) {
        await flushDigest(sessionId);
        await updateSessionState(sessionId, {
          type: 'errored',
          sessionId,
          source: session.provider === 'claude' ? 'claude' : 'codex',
          confidence: 'high',
          timestamp: Date.now(),
          metadata: { errorMessage: errMsg },
        });
      }
    }
  } finally {
    streamer.destroy();
  }

  return {
    text: streamer.getText(),
    askedUser,
    askUserQuestionsJson,
    hadError,
    success,
    commandCount,
    fileChangeCount,
    recentCommands,
    changedFiles,
  };
}
