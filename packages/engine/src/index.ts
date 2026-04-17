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
export {
  type BatchAction,
  type BatchApprovalEntry,
  enqueueBatchApproval,
  drainBatchApprovals,
  getBatchApprovalQueue,
  getBatchApprovalCount,
  clearBatchApprovalStore,
} from './output/batch-approval-store.ts';

// Session sub-modules
export { resolveEffectiveClaudePermissionMode, resolveEffectiveCodexOptions } from './session/permissions.ts';

// SessionContext supervisor (P5)
export {
  type SessionContext,
  sessionSupervisor,
  getSessionContext,
  requireSessionContext,
  getSessionView,
} from './session-context.ts';

// MonitorRun persistence (P3b)
export {
  type MonitorRun,
  beginMonitorRun,
  checkpointMonitorRun,
  finishMonitorRun,
  listRunningMonitorRuns,
  listMonitorRunsForSession,
  getMonitorRun,
  reconcileMonitorRunsOnStartup,
} from './executor/monitor-run-store.ts';
export {
  type MonitorAutoResumePolicy,
  type MonitorAutoResumeCandidate,
  type ReconcileResult,
  reconcileAndCollectAutoResumeCandidates,
} from './executor/monitor-autoresume.ts';
