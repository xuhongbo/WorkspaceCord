// Thread Manager — session-registry / provider runtime / 本地会话注册 的 façade

import type { ProviderEvent, ContentBlock } from './providers/index.ts';
import type { ProviderCanUseTool } from './providers/types.ts';
import {
  sendPrompt as sendPromptWithRuntime,
  continueSessionWithOverrides as continueSessionWithRuntime,
  sendMonitorPrompt as sendMonitorPromptWithRuntime,
} from './session/session-provider-runtime.ts';
import {
  buildClaudeSubagentProviderSessionId,
  registerLocalSession,
  updateLocalObservation,
} from './session/session-local-registration.ts';

// Re-export the registry surface for compatibility with existing callers.
export {
  loadSessions, createSession, getSession, getSessionByChannel, getSessionByThread,
  getSessionByCodexId, getSessionByProviderSession, getSessionsByCategory, getAllSessions,
  findCodexSessionForMonitor, findCodexSessionByProviderSessionId, findCodexSessionByCwd,
  resolveCodexSessionFromMonitor, updateSession, updateSessionPermissions,
  resolveEffectiveClaudePermissionMode, resolveEffectiveCodexOptions,
  getSessionPermissionSummary, getSessionPermissionDetails, setStatusCardBinding,
  setCurrentInteractionMessage, endSession, setMode, setVerbose, setModel,
  setAgentPersona, setMonitorGoal, updateWorkflowState, resetWorkflowState,
  abortSession, abortSessionWithReason, consumeAbortReason,
} from './session-registry.ts';
export type { CreateSessionParams } from './session-registry.ts';

// ─── Provider runtime façade ───────────────────────────────────────────────

export async function* sendPrompt(
  sessionId: string,
  prompt: string | ContentBlock[],
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): AsyncGenerator<ProviderEvent> {
  yield* sendPromptWithRuntime(sessionId, prompt, runtimeOverrides);
}

export async function* continueSession(sessionId: string): AsyncGenerator<ProviderEvent> {
  yield* continueSessionWithOverrides(sessionId);
}

export async function* continueSessionWithOverrides(
  sessionId: string,
  runtimeOverrides: { canUseTool?: ProviderCanUseTool } = {},
): AsyncGenerator<ProviderEvent> {
  yield* continueSessionWithRuntime(sessionId, runtimeOverrides);
}

export async function* sendMonitorPrompt(
  sessionId: string,
  prompt: string,
): AsyncGenerator<ProviderEvent> {
  yield* sendMonitorPromptWithRuntime(sessionId, prompt);
}

// ─── Local session helpers façade ───────────────────────────────────────────

export {
  buildClaudeSubagentProviderSessionId,
  registerLocalSession,
  updateLocalObservation,
};
export type {
  RegisterLocalSessionParams,
  RegisterLocalSessionResult,
} from './session/session-local-registration.ts';
