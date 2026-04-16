// Output event handler registry — 将 output-handler 的 30+ case 的大 switch
// 拆成按事件类型分发的 handler map。每个 handler 只处理一种事件,
// 便于单测、替换和扩展（例如未来支持新的 ProviderEvent 类型）。

import { existsSync } from 'node:fs';
import type { ProviderEvent } from '@workspacecord/providers';
import { truncate } from '@workspacecord/core';
import type { TextChannel } from 'discord.js';
import type { SessionChannel } from '../discord-types.ts';
import { getSession } from '@workspacecord/engine/session-registry';
import { autoSpawnSubagentThread } from '../subagent-manager.ts';
import {
  updateSessionState,
  queueDigest,
  flushDigest,
  handleAwaitingHuman,
} from '../panel-adapter.ts';
import {
  renderCommandExecutionEmbed,
  renderFileChangesEmbed,
  renderReasoningEmbed,
  renderCodexTodoListEmbed,
} from '../codex-renderer.ts';
import type { MessageStreamer } from './message-streamer.ts';
import { shouldSuppressCommandExecution } from './interaction-controls.ts';

export { renderCommandExecutionEmbed, renderFileChangesEmbed, renderReasoningEmbed, renderCodexTodoListEmbed };

/** 每轮流处理期间累加的运行时状态（由 output-handler 拥有,handler 通过 ctx 修改）。 */
export interface StreamState {
  askedUser: boolean;
  askUserQuestionsJson?: string;
  hadError: boolean;
  success: boolean | null;
  commandCount: number;
  fileChangeCount: number;
  recentCommands: string[];
  changedFiles: string[];
  pendingAttachments: string[];
  lastToolName: string | null;
  taskThreadMap: Map<string, string>;
  deferredResult?: {
    event: Extract<ProviderEvent, { type: 'result' }>;
    text: string;
    attachments: string[];
  };
}

export interface EventContext {
  sessionId: string;
  channel: SessionChannel;
  streamer: MessageStreamer;
  verbose: boolean;
  mode: string;
  state: StreamState;
}

export type EventHandler<T extends ProviderEvent['type']> = (
  event: Extract<ProviderEvent, { type: T }>,
  ctx: EventContext,
) => void | Promise<void>;

type HandlerMap = {
  [K in ProviderEvent['type']]?: EventHandler<K>;
};

function providerSource(sessionId: string): 'claude' | 'codex' {
  const session = getSession(sessionId);
  return session?.provider === 'codex' ? 'codex' : 'claude';
}

// ─── handlers ────────────────────────────────────────────────────────────────

const textDelta: EventHandler<'text_delta'> = (event, ctx) => {
  ctx.streamer.append(event.text);
};

const askUser: EventHandler<'ask_user'> = async (event, ctx) => {
  ctx.state.askedUser = true;
  ctx.state.askUserQuestionsJson = event.questionsJson;
  await ctx.streamer.discard();
  const session = getSession(ctx.sessionId);
  if (!session) return;
  const source = providerSource(ctx.sessionId);
  await updateSessionState(ctx.sessionId, {
    type: 'awaiting_human',
    sessionId: ctx.sessionId,
    source,
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { detail: event.questionsJson },
  });
  await flushDigest(ctx.sessionId);
  await handleAwaitingHuman(ctx.sessionId, event.questionsJson, { source });
};

const task: EventHandler<'task'> = async (event, ctx) => {
  await ctx.streamer.finalize();
  queueDigest(ctx.sessionId, { kind: 'tool', text: `任务工具：${event.action}` });
  ctx.state.lastToolName = event.action;
};

const taskStarted: EventHandler<'task_started'> = async (event, ctx) => {
  await ctx.streamer.finalize();
  queueDigest(ctx.sessionId, {
    kind: 'subagent',
    text: `子代理启动：${truncate(event.description, 80)}`,
  });
  const session = getSession(ctx.sessionId);
  if (!session || ctx.channel.type === undefined) return;
  autoSpawnSubagentThread(session, event.taskId, event.description, ctx.channel as TextChannel)
    .then((result) => {
      if (result) ctx.state.taskThreadMap.set(event.taskId, result.threadId);
    })
    .catch((err) =>
      console.warn(
        `[OutputHandler] Failed to auto-spawn thread for task ${event.taskId}: ${(err as Error).message}`,
      ),
    );
};

const taskProgress: EventHandler<'task_progress'> = (event, ctx) => {
  if (event.summary) {
    queueDigest(ctx.sessionId, {
      kind: 'subagent',
      text: `子代理进展：${truncate(event.summary, 100)}`,
    });
  }
  const threadId = ctx.state.taskThreadMap.get(event.taskId);
  if (!threadId || !event.summary) return;
  const thread = (ctx.channel as TextChannel).threads?.cache.get(threadId);
  if (!thread) return;
  thread.send(`📝 ${truncate(event.summary, 1900)}`).catch((e) =>
    console.warn(
      `[OutputHandler] Failed to send progress to thread: ${(e as Error).message}`,
    ),
  );
};

const taskDone: EventHandler<'task_done'> = async (event, ctx) => {
  await ctx.streamer.finalize();
  queueDigest(ctx.sessionId, {
    kind: 'subagent',
    text: `子代理${event.status === 'completed' ? '完成' : '结束'}：${truncate(event.summary || 'No summary.', 100)}`,
  });
  const threadId = ctx.state.taskThreadMap.get(event.taskId);
  if (!threadId) return;
  const thread = (ctx.channel as TextChannel).threads?.cache.get(threadId);
  if (thread) {
    const emoji = event.status === 'completed' ? '✅' : '❌';
    thread
      .send(`${emoji} 子任务${event.status === 'completed' ? '完成' : '结束'}：${truncate(event.summary || '', 1900)}`)
      .catch((e) =>
        console.warn(
          `[OutputHandler] Failed to send task done to thread: ${(e as Error).message}`,
        ),
      );
  }
  ctx.state.taskThreadMap.delete(event.taskId);
};

const webSearch: EventHandler<'web_search'> = (event, ctx) => {
  if (ctx.verbose) {
    queueDigest(ctx.sessionId, { kind: 'search', text: `检索：${truncate(event.query, 80)}` });
  }
};

const toolStart: EventHandler<'tool_start'> = async (event, ctx) => {
  await ctx.streamer.finalize();
  queueDigest(ctx.sessionId, { kind: 'tool', text: `工具：${event.toolName}` });
  ctx.state.lastToolName = event.toolName;
};

const toolResult: EventHandler<'tool_result'> = async (event, ctx) => {
  await ctx.streamer.finalize();
  if (ctx.verbose && event.result) {
    queueDigest(ctx.sessionId, {
      kind: 'tool',
      text: `工具结果：${truncate(ctx.state.lastToolName || event.toolName || 'tool', 60)}`,
    });
  }
};

const imageFile: EventHandler<'image_file'> = (event, ctx) => {
  if (existsSync(event.filePath)) {
    ctx.state.pendingAttachments.push(event.filePath);
  }
};

const commandExecution: EventHandler<'command_execution'> = (event, ctx) => {
  ctx.state.commandCount++;
  if (ctx.state.recentCommands.length < 8) ctx.state.recentCommands.push(event.command);
  if (!shouldSuppressCommandExecution(event.command)) {
    queueDigest(ctx.sessionId, {
      kind: 'command',
      text: `命令：${truncate(event.command, 80)}${event.exitCode !== null ? `（退出码 ${event.exitCode}）` : ''}`,
    });
  }
};

const fileChange: EventHandler<'file_change'> = (event, ctx) => {
  ctx.state.fileChangeCount += event.changes.length;
  for (const change of event.changes) {
    if (!change.filePath) continue;
    if (ctx.state.changedFiles.includes(change.filePath)) continue;
    if (ctx.state.changedFiles.length >= 12) break;
    ctx.state.changedFiles.push(change.filePath);
  }
  queueDigest(ctx.sessionId, {
    kind: 'file',
    text: `文件变更：${event.changes.length} 个（最近：${truncate(ctx.state.changedFiles.slice(-3).join(', '), 120)}）`,
  });
};

const reasoning: EventHandler<'reasoning'> = (event, ctx) => {
  if (ctx.verbose) {
    queueDigest(ctx.sessionId, { kind: 'reasoning', text: `推理：${truncate(event.text, 100)}` });
  }
};

const todoList: EventHandler<'todo_list'> = (event, ctx) => {
  const completed = event.items.filter((item) => item.completed).length;
  queueDigest(ctx.sessionId, {
    kind: 'todo',
    text: `待办更新：${completed}/${event.items.length} 已完成`,
  });
};

const MODE_LABELS: Record<string, string> = {
  auto: '自动',
  plan: '计划',
  normal: '普通',
  monitor: '监控',
};

const result: EventHandler<'result'> = async (event, ctx) => {
  ctx.state.success = event.success;
  const lastText = ctx.streamer.getText();
  const cost = event.costUsd.toFixed(4);
  const duration = event.durationMs ? `${(event.durationMs / 1000).toFixed(1)}s` : 'unknown';
  const turns = event.numTurns || 0;
  const modeLabel = MODE_LABELS[ctx.mode] || '自动';
  const statusLine = event.success
    ? `-# $${cost} | ${duration} | ${turns} turns | ${modeLabel}`
    : `-# Error | $${cost} | ${duration} | ${turns} turns`;

  ctx.streamer.append(`\n${statusLine}`, { persist: false });
  if (!event.success && event.errors.length) {
    ctx.streamer.append(`\n\`\`\`\n${event.errors.join('\n')}\n\`\`\``, { persist: false });
  }
  await ctx.streamer.finalize();

  const session = getSession(ctx.sessionId);
  if (!session) {
    ctx.state.pendingAttachments = [];
    return;
  }

  if (ctx.mode === 'monitor') {
    await flushDigest(ctx.sessionId);
    await updateSessionState(ctx.sessionId, {
      type: 'work_started',
      sessionId: ctx.sessionId,
      source: providerSource(ctx.sessionId),
      confidence: 'high',
      timestamp: Date.now(),
      metadata: {
        phase: '等待监督判断',
        summary: event.success ? '本轮执行结束，等待监督判断' : '本轮执行失败，等待监督判断',
      },
    });
  } else {
    ctx.state.deferredResult = {
      event,
      text: lastText,
      attachments: [...ctx.state.pendingAttachments],
    };
  }
  ctx.state.pendingAttachments = [];
};

const errorEvent: EventHandler<'error'> = async (event, ctx) => {
  console.warn(`[OutputHandler] Session ${ctx.sessionId}: error event — ${event.message}`);
  ctx.state.hadError = true;
  await ctx.streamer.finalize();
  queueDigest(ctx.sessionId, { kind: 'error', text: `错误：${truncate(event.message, 120)}` });
  if (ctx.mode === 'monitor') return;
  const session = getSession(ctx.sessionId);
  if (!session) return;
  await flushDigest(ctx.sessionId);
  await updateSessionState(ctx.sessionId, {
    type: 'errored',
    sessionId: ctx.sessionId,
    source: providerSource(ctx.sessionId),
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { errorMessage: event.message },
  });
};

const sessionInit: EventHandler<'session_init'> = () => {
  // Threads don't have topics; metadata is stored in session JSON only
};

export const EVENT_HANDLERS: HandlerMap = {
  text_delta: textDelta,
  ask_user: askUser,
  task,
  task_started: taskStarted,
  task_progress: taskProgress,
  task_done: taskDone,
  web_search: webSearch,
  tool_start: toolStart,
  tool_result: toolResult,
  image_file: imageFile,
  command_execution: commandExecution,
  file_change: fileChange,
  reasoning,
  todo_list: todoList,
  result,
  error: errorEvent,
  session_init: sessionInit,
};

export async function dispatchEvent(event: ProviderEvent, ctx: EventContext): Promise<void> {
  const handler = EVENT_HANDLERS[event.type] as EventHandler<typeof event.type> | undefined;
  if (!handler) return;
  await handler(event as never, ctx);
}
