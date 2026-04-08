// @workspacecord/engine — session management, execution, output abstraction

// Output port (interface + registration)
export {
  type SessionOutputPort,
  type OutputStreamResult,
  registerOutputPort,
  getOutputPort,
} from './output-port.ts';

// Session registry
export {
  loadSessions,
  createSession,
  getSession,
  getSessionByChannel,
  getSessionByThread,
  getSessionByCodexId,
  getSessionByProviderSession,
  getSessionsByCategory,
  getAllSessions,
  findCodexSessionForMonitor,
  findCodexSessionByProviderSessionId,
  findCodexSessionByCwd,
  resolveCodexSessionFromMonitor,
  updateSession,
  updateSessionPermissions,
  setStatusCardBinding,
  setCurrentInteractionMessage,
  endSession,
  setMode,
  setVerbose,
  setModel,
  setAgentPersona,
  setMonitorGoal,
  updateWorkflowState,
  resetWorkflowState,
  abortSession,
  abortSessionWithReason,
  consumeAbortReason,
  getSessionController,
  setSessionController,
  clearSessionController,
  clearSessionAbortReason,
  markSessionGenerating,
  saveSessionImmediate,
  debouncedSaveSession,
} from './session-registry.ts';

// Session execution
export { executeSessionPrompt, executeSessionContinue } from './session-executor.ts';

// Project management
export {
  loadRegistry,
  registerProject,
  getAllRegisteredProjects,
  getProjectByPath,
  renameProject,
  removeProject,
  unbindProjectCategory,
} from './project-registry.ts';
export { loadProjects } from './project-manager.ts';

// Agents
export { agents } from './agents.ts';

// Output stores
export {
  setPendingAnswer,
  getPendingAnswers,
  clearPendingAnswers,
  getQuestionCount,
} from './output/answer-store.ts';
export { getExpandableContent } from './output/expandable-store.ts';

// Session sub-modules
export { resolveEffectiveClaudePermissionMode, resolveEffectiveCodexOptions } from './session/permissions.ts';
