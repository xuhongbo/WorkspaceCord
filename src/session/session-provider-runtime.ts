import { ensureProvider, type ProviderEvent, type ContentBlock } from '../providers/index.ts';
import type { ProviderCanUseTool, ProviderSessionOptions } from '../providers/types.ts';
import type { ThreadSession } from '../types.ts';
import { config } from '../config.ts';
import { isAbortError } from '../utils.ts';
import * as registry from '../session-registry.ts';
import { buildMonitorSystemPromptParts, buildSystemPromptParts } from './session-prompt-assembler.ts';

function buildProviderOptions(
  session: ThreadSession,
  controller: AbortController,
  isMonitor = false,
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): ProviderSessionOptions {
  const effectiveCodex = registry.resolveEffectiveCodexOptions(session);

  return {
    directory: session.directory,
    providerSessionId: isMonitor ? session.monitorProviderSessionId : session.providerSessionId,
    model: session.model,
    sandboxMode: effectiveCodex.sandboxMode,
    approvalPolicy: effectiveCodex.approvalPolicy,
    networkAccessEnabled: effectiveCodex.networkAccessEnabled,
    webSearchMode: effectiveCodex.webSearchMode,
    modelReasoningEffort: config.codexReasoningEffort || undefined,
    claudePermissionMode: registry.resolveEffectiveClaudePermissionMode(session),
    systemPromptParts: isMonitor
      ? buildMonitorSystemPromptParts(session)
      : buildSystemPromptParts(session),
    abortController: controller,
    canUseTool: runtimeOverrides.canUseTool,
  };
}

export async function* sendPrompt(
  sessionId: string,
  prompt: string | ContentBlock[],
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): AsyncGenerator<ProviderEvent> {
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  registry.setSessionController(session.id, controller);
  registry.markSessionGenerating(session.id, true);

  const provider = await ensureProvider(session.provider);

  try {
    const stream = provider.sendPrompt(
      prompt,
      buildProviderOptions(session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        const current = registry.getSession(sessionId);
        if (current) {
          current.providerSessionId = event.providerSessionId || undefined;
          registry.debouncedSaveSession();
        }
      }
      if (event.type === 'result') {
        const current = registry.getSession(sessionId);
        if (current) current.totalCost += event.costUsd;
      }
      yield event;
    }

    const current = registry.getSession(sessionId);
    if (current) current.messageCount++;
  } catch (err: unknown) {
    if (!isAbortError(err)) {
      throw err;
    }
  } finally {
    try {
      registry.markSessionGenerating(sessionId, false);
      registry.clearSessionController(sessionId);
      await registry.saveSessionImmediate();
    } catch (cleanupErr) {
      console.error(`[ProviderRuntime] cleanup error for session ${sessionId}:`, cleanupErr);
      // Ensure isGenerating is reset even if save fails
      const s = registry.getSession(sessionId);
      if (s) s.isGenerating = false;
    }
  }
}

export async function* continueSession(
  sessionId: string,
): AsyncGenerator<ProviderEvent> {
  yield* continueSessionWithOverrides(sessionId);
}

export async function* continueSessionWithOverrides(
  sessionId: string,
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): AsyncGenerator<ProviderEvent> {
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);
  if (session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  registry.setSessionController(session.id, controller);
  registry.markSessionGenerating(session.id, true);

  const provider = await ensureProvider(session.provider);

  try {
    const stream = provider.continueSession(
      buildProviderOptions(session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        const current = registry.getSession(sessionId);
        if (current) {
          current.providerSessionId = event.providerSessionId || undefined;
          registry.debouncedSaveSession();
        }
      }
      if (event.type === 'result') {
        const current = registry.getSession(sessionId);
        if (current) current.totalCost += event.costUsd;
      }
      yield event;
    }

    const current = registry.getSession(sessionId);
    if (current) current.messageCount++;
  } catch (err: unknown) {
    if (!isAbortError(err)) {
      throw err;
    }
  } finally {
    try {
      registry.markSessionGenerating(sessionId, false);
      registry.clearSessionController(sessionId);
      await registry.saveSessionImmediate();
    } catch (cleanupErr) {
      console.error(`[ProviderRuntime] cleanup error for session ${sessionId}:`, cleanupErr);
      const s = registry.getSession(sessionId);
      if (s) s.isGenerating = false;
    }
  }
}

export async function* sendMonitorPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<ProviderEvent> {
  const session = registry.getSession(sessionId);
  if (!session) throw new Error(`Session "${sessionId}" not found`);

  const provider = await ensureProvider(session.provider);
  const current = registry.getSession(sessionId);
  if (current) current.lastActivity = Date.now();

  // Link to the session's main abort controller so aborting the session also aborts the monitor
  const mainController = registry.getSessionController(sessionId);
  const controller = new AbortController();
  const onMainAbort = () => controller.abort();
  mainController?.signal.addEventListener('abort', onMainAbort, { once: true });

  try {
    const stream = provider.sendPrompt(prompt, buildProviderOptions(session, controller, true));

    for await (const event of stream) {
      if (event.type === 'session_init') {
        const cur = registry.getSession(sessionId);
        if (cur) {
          cur.monitorProviderSessionId = event.providerSessionId || undefined;
          registry.debouncedSaveSession();
        }
      }
      if (event.type === 'result') {
        const cur = registry.getSession(sessionId);
        if (cur) cur.totalCost += event.costUsd;
      }
      yield event;
    }

    const cur = registry.getSession(sessionId);
    if (cur) cur.lastActivity = Date.now();
    registry.debouncedSaveSession();
  } catch (err: unknown) {
    if (!isAbortError(err)) {
      throw err;
    }
  } finally {
    mainController?.signal.removeEventListener('abort', onMainAbort);
  }
}
