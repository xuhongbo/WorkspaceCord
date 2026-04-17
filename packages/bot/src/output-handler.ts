import type { SessionChannel } from './discord-types.ts';
import { truncate, isAbortError } from '@workspacecord/core';
import type { ProviderEvent, ProviderName } from '@workspacecord/providers';
import { getSessionView } from '@workspacecord/engine/session-context';
import {
  initializeSessionPanel,
  updateSessionState,
  handleResultEvent,
  queueDigest,
  flushDigest,
} from './panel-adapter.ts';
import { MessageStreamer } from './output/message-streamer.ts';
import { dispatchEvent, type StreamState } from './output/event-handlers.ts';

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
  shouldSuppressCommandExecution,
} from './output/interaction-controls.ts';

const DIGEST_FLUSH_INTERVAL_MS = 8000;

function createInitialState(): StreamState {
  return {
    askedUser: false,
    hadError: false,
    success: null,
    commandCount: 0,
    fileChangeCount: 0,
    recentCommands: [],
    changedFiles: [],
    pendingAttachments: [],
    lastToolName: null,
    taskThreadMap: new Map<string, string>(),
  };
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
  console.log(
    `[OutputHandler] Stream started for session ${sessionId} (provider: ${_provider}, mode: ${mode}, verbose: ${verbose})`,
  );

  const state = createInitialState();
  let lastDigestFlushAt = Date.now();
  const session = getSessionView(sessionId);

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

  const ctx = { sessionId, channel, streamer, verbose, mode, state };

  try {
    for await (const event of stream) {
      options.onEvent?.(event);
      await dispatchEvent(event, ctx);

      if (session && Date.now() - lastDigestFlushAt >= DIGEST_FLUSH_INTERVAL_MS) {
        await flushDigest(sessionId);
        lastDigestFlushAt = Date.now();
      }
    }

    if (session && mode !== 'monitor' && state.deferredResult) {
      console.log(
        `[OutputHandler] Session ${sessionId}: delivering deferred result (success: ${state.deferredResult.event.success})`,
      );
      await flushDigest(sessionId);
      await handleResultEvent(
        sessionId,
        state.deferredResult.event,
        state.deferredResult.text,
        state.deferredResult.attachments,
      );
    }
  } catch (err: unknown) {
    state.hadError = true;
    await streamer.finalize();
    if (!isAbortError(err)) {
      const errMsg = (err as Error).message || '';
      console.error(`[OutputHandler] Session ${sessionId}: unhandled stream error — ${errMsg}`);
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
  console.log(
    `[OutputHandler] Stream ended for session ${sessionId} (text: ${finalText.length} chars, commands: ${state.commandCount}, files: ${state.fileChangeCount}, success: ${state.success}, hadError: ${state.hadError})`,
  );

  return {
    text: finalText,
    askedUser: state.askedUser,
    askUserQuestionsJson: state.askUserQuestionsJson,
    hadError: state.hadError,
    success: state.success,
    commandCount: state.commandCount,
    fileChangeCount: state.fileChangeCount,
    recentCommands: state.recentCommands,
    changedFiles: state.changedFiles,
  };
}
