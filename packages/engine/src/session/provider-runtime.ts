import { ensureProvider } from '@workspacecord/providers';
import type { ProviderEvent, ContentBlock, ProviderCanUseTool, ProviderSessionOptions } from '@workspacecord/providers';
import type { ThreadSession } from '@workspacecord/core';
import { config, isAbortError } from '@workspacecord/core';
import {
  resolveEffectiveCodexOptions,
  resolveEffectiveClaudePermissionMode,
  setSessionController,
  clearSessionController,
  markSessionGenerating,
  debouncedSaveSession,
  saveSessionImmediate,
  getSessionController,
} from '../session-registry.ts';
import { getSessionContext } from '../session-context.ts';
import { buildMonitorSystemPromptParts, buildSystemPromptParts } from './prompt-assembler.ts';

export function buildProviderOptions(
  session: ThreadSession,
  controller: AbortController,
  isMonitor = false,
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): ProviderSessionOptions {
  const effectiveCodex = resolveEffectiveCodexOptions(session);
  const monitorEffort = isMonitor ? config.monitorReasoningEffort || undefined : undefined;

  // Monitor pass on Claude with high/xhigh effort → use the stronger judge model
  const useMonitorJudgeModel =
    isMonitor &&
    session.provider === 'claude' &&
    (monitorEffort === 'high' || monitorEffort === 'xhigh');
  const model = useMonitorJudgeModel ? config.monitorClaudeModel || session.model : session.model;

  return {
    directory: session.directory,
    providerSessionId: isMonitor ? session.monitorProviderSessionId : session.providerSessionId,
    model,
    sandboxMode: effectiveCodex.sandboxMode,
    approvalPolicy: effectiveCodex.approvalPolicy,
    networkAccessEnabled: effectiveCodex.networkAccessEnabled,
    webSearchMode: effectiveCodex.webSearchMode,
    modelReasoningEffort: monitorEffort ?? (config.codexReasoningEffort || undefined),
    claudePermissionMode: resolveEffectiveClaudePermissionMode(session),
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
  const ctx = getSessionContext(sessionId);
  if (!ctx) throw new Error(`Session "${sessionId}" not found`);
  if (ctx.session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  setSessionController(ctx.sessionId, controller);
  markSessionGenerating(ctx.sessionId, true);

  const provider = await ensureProvider(ctx.session.provider);

  try {
    const stream = provider.sendPrompt(
      prompt,
      buildProviderOptions(ctx.session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        ctx.session.providerSessionId = event.providerSessionId || undefined;
        ctx.save();
      }
      if (event.type === 'result') {
        ctx.session.totalCost += event.costUsd;
      }
      yield event;
    }

    ctx.session.messageCount++;
  } catch (err: unknown) {
    if (!isAbortError(err)) {
      throw err;
    }
  } finally {
    try {
      markSessionGenerating(sessionId, false);
      clearSessionController(sessionId);
      await saveSessionImmediate();
    } catch (cleanupErr) {
      console.error(`[ProviderRuntime] cleanup error for session ${sessionId}:`, cleanupErr);
      // 降级:即便落盘失败,也要把 isGenerating 复位,防止后续误判
      const fallback = getSessionContext(sessionId);
      if (fallback) fallback.session.isGenerating = false;
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
  const ctx = getSessionContext(sessionId);
  if (!ctx) throw new Error(`Session "${sessionId}" not found`);
  if (ctx.session.isGenerating) throw new Error('Session is already generating');

  const controller = new AbortController();
  setSessionController(ctx.sessionId, controller);
  markSessionGenerating(ctx.sessionId, true);

  const provider = await ensureProvider(ctx.session.provider);

  try {
    const stream = provider.continueSession(
      buildProviderOptions(ctx.session, controller, false, runtimeOverrides),
    );

    for await (const event of stream) {
      if (event.type === 'session_init') {
        ctx.session.providerSessionId = event.providerSessionId || undefined;
        ctx.save();
      }
      if (event.type === 'result') {
        ctx.session.totalCost += event.costUsd;
      }
      yield event;
    }

    ctx.session.messageCount++;
  } catch (err: unknown) {
    if (!isAbortError(err)) {
      throw err;
    }
  } finally {
    try {
      markSessionGenerating(sessionId, false);
      clearSessionController(sessionId);
      await saveSessionImmediate();
    } catch (cleanupErr) {
      console.error(`[ProviderRuntime] cleanup error for session ${sessionId}:`, cleanupErr);
      const fallback = getSessionContext(sessionId);
      if (fallback) fallback.session.isGenerating = false;
    }
  }
}

export async function* sendMonitorPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<ProviderEvent> {
  const ctx = getSessionContext(sessionId);
  if (!ctx) throw new Error(`Session "${sessionId}" not found`);

  const provider = await ensureProvider(ctx.session.provider);
  ctx.session.lastActivity = Date.now();

  // 与主 session 的 abort controller 联动:主任务被中止时 monitor 也一并终止
  const mainController = getSessionController(sessionId);
  const controller = new AbortController();
  const onMainAbort = () => controller.abort();
  mainController?.signal.addEventListener('abort', onMainAbort, { once: true });

  try {
    const stream = provider.sendPrompt(prompt, buildProviderOptions(ctx.session, controller, true));

    for await (const event of stream) {
      if (event.type === 'session_init') {
        ctx.session.monitorProviderSessionId = event.providerSessionId || undefined;
        ctx.save();
      }
      if (event.type === 'result') {
        ctx.session.totalCost += event.costUsd;
      }
      yield event;
    }

    ctx.session.lastActivity = Date.now();
    debouncedSaveSession();
  } catch (err: unknown) {
    if (!isAbortError(err)) {
      throw err;
    }
  } finally {
    mainController?.signal.removeEventListener('abort', onMainAbort);
  }
}
