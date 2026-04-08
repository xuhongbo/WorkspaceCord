import type { SessionChannel } from './discord-types.ts';
import { existsSync } from 'node:fs';
import { config, truncate, isAbortError } from '@workspacecord/core';
import type { ProviderEvent, ProviderName } from '@workspacecord/providers';
import {
  renderCommandExecutionEmbed,
  renderFileChangesEmbed,
  renderReasoningEmbed,
  renderCodexTodoListEmbed,
} from './codex-renderer.ts';
import { getSession } from '@workspacecord/engine/session-registry';
import {
  initializeSessionPanel,
  updateSessionState,
  handleResultEvent,
  handleAwaitingHuman,
  queueDigest,
  flushDigest,
} from './panel-adapter.ts';
import { MessageStreamer } from './output/message-streamer.ts';
import { shouldSuppressCommandExecution } from './output/interaction-controls.ts';
export {
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
} from '@workspacecord/engine/output/answer-store';
export { getExpandableContent } from '@workspacecord/engine/output/expandable-store';
export {
  makeModeButtons,
  makeOptionButtons,
  makeYesNoButtons,
  renderAskUserQuestion,
  resolveEffectiveClaudePermissionMode,
  shouldSuppressCommandExecution
} from './output/interaction-controls.ts';

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
  console.log(`[OutputHandler] Stream started for session ${sessionId} (provider: ${_provider}, mode: ${mode}, verbose: ${verbose})`);
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
  let deferredResult:
    | {
        event: Extract<ProviderEvent, { type: 'result' }>;
        text: string;
        attachments: string[];
      }
    | undefined;
  let lastDigestFlushAt = Date.now();
  const session = getSession(sessionId);

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
          console.log(`[OutputHandler] Session ${sessionId}: ask_user event (human input requested)`);
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
              deferredResult = {
                event,
                text: lastText,
                attachments: [...pendingAttachments],
              };
            }
          }
          pendingAttachments.length = 0;
         break;
        }

        case 'error': {
          console.warn(`[OutputHandler] Session ${sessionId}: error event — ${event.message}`);
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

    if (session && mode !== 'monitor' && deferredResult) {
      console.log(`[OutputHandler] Session ${sessionId}: delivering deferred result (success: ${deferredResult.event.success})`);
      await flushDigest(sessionId);
      await handleResultEvent(
        sessionId,
        deferredResult.event,
        deferredResult.text,
        deferredResult.attachments,
      );
    }
  } catch (err: unknown) {
    hadError = true;
    await streamer.finalize();
    if (!isAbortError(err)) {
      console.error(`[OutputHandler] Session ${sessionId}: unhandled stream error — ${(err as Error).message || ''}`);
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

  const finalText = streamer.getText();
  console.log(`[OutputHandler] Stream ended for session ${sessionId} (text: ${finalText.length} chars, commands: ${commandCount}, files: ${fileChangeCount}, success: ${success}, hadError: ${hadError})`);

  return {
    text: finalText,
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
