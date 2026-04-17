try { process.loadEnvFile(); } catch { /* .env not required */ }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRegistry } from '../packages/engine/src/project-registry.ts';
import { loadSessions, createSession, endSession } from '../packages/engine/src/session-registry.ts';
import { loadProjects } from '../packages/engine/src/project-manager.ts';
import { _setDataDirForTest } from '../packages/core/src/persistence.ts';
import { registerOutputPort } from '../packages/engine/src/output-port.ts';
import { gateCoordinator } from '../packages/state/src/index.ts';

interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

interface GateReport {
  startedAt: string;
  finishedAt?: string;
  reportPath: string;
  steps: StepResult[];
}

function step(report: GateReport, name: string, status: StepResult['status'], detail: string) {
  report.steps.push({ name, status, detail });
  const icon = status === 'passed' ? '\u2713' : status === 'skipped' ? '-' : '\u2717';
  process.stdout.write(`${icon} ${name}: ${detail}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const artifactsDir = join(process.cwd(), 'local-acceptance');
mkdirSync(artifactsDir, { recursive: true });
const reportPath = join(artifactsDir, 'gate-e2e-report.json');

const report: GateReport = {
  startedAt: new Date().toISOString(),
  reportPath,
  steps: [],
};

const tempDir = mkdtempSync(join(tmpdir(), 'gate-e2e-'));

try {
  _setDataDirForTest(tempDir);
  // Register a no-op OutputPort stub (gate-e2e runs without Discord)
  registerOutputPort({
    initializePanel: async () => {},
    updateState: async () => {},
    handleResult: async () => {},
    handleAwaitingHuman: async () => {},
    relocatePanel: async () => {},
    cleanupPanel: () => {},
    getProjection: () => ({ state: 'idle' }) as never,
    handleOutputStream: async () => ({ text: '', askedUser: false, hadError: false, success: true, commandCount: 0, fileChangeCount: 0, recentCommands: [], changedFiles: [] }),
    queueDigest: () => {},
    flushDigest: async () => {},
  });
  await loadRegistry();
  await loadProjects();
  await loadSessions();
  step(report, 'setup', 'passed', `temp data dir: ${tempDir}`);

  // 1. Create a session for gate testing
  const session = await createSession({
    channelId: 'gate-e2e-channel',
    categoryId: 'gate-e2e-cat',
    projectName: 'gate-e2e',
    agentLabel: 'gate-test',
    provider: 'claude',
    directory: tempDir,
    type: 'persistent',
  });
  step(report, 'create-session', 'passed', `session ${session.id}`);

  // 2. Create a gate
  const gate = gateCoordinator.createGate({
    sessionId: session.id,
    provider: 'claude',
    type: 'binary_approval',
    isBlocking: true,
    supportsRemoteDecision: true,
    summary: 'E2E test gate',
    turn: 1,
  });
  if (!gate || !gate.id) throw new Error('createGate returned no gate');
  step(report, 'create-gate', 'passed', `gate ${gate.id}, status=${gate.status}`);

  // 3. Lookup gate by session
  const found = gateCoordinator.getActiveGateForSession(session.id);
  if (!found || found.id !== gate.id) throw new Error(`lookup returned ${found?.id ?? 'undefined'}`);
  step(report, 'lookup-gate', 'passed', `found gate ${found.id} for session`);

  // 4. Verify pending status
  if (found.status !== 'pending') throw new Error(`expected pending, got ${found.status}`);
  step(report, 'verify-pending', 'passed', 'gate is pending');

  // 5. Resolve from terminal
  const resolveResult = gateCoordinator.notifyTerminalResolved(gate.id, 'approve');
  if (!resolveResult.success) throw new Error(`resolve failed: ${resolveResult.message}`);
  step(report, 'resolve-gate', 'passed', 'terminal approve succeeded');

  // 6. Verify resolved state
  const resolved = gateCoordinator.getGate(gate.id);
  if (!resolved) throw new Error('gate not found after resolve');
  if (resolved.status !== 'approved') throw new Error(`expected approved, got ${resolved.status}`);
  if (resolved.resolvedBy !== 'terminal') throw new Error(`expected terminal, got ${resolved.resolvedBy}`);
  step(report, 'verify-resolved', 'passed', `status=${resolved.status}, resolvedBy=${resolved.resolvedBy}`);

  // 7. Create a second gate and test double-resolve prevention
  const gate2 = gateCoordinator.createGate({
    sessionId: session.id,
    provider: 'claude',
    type: 'binary_approval',
    isBlocking: true,
    supportsRemoteDecision: false,
    summary: 'E2E double-resolve test',
    turn: 2,
  });
  gateCoordinator.notifyTerminalResolved(gate2.id, 'reject');
  const doubleResolve = gateCoordinator.notifyTerminalResolved(gate2.id, 'approve');
  if (doubleResolve.success) throw new Error('double resolve should fail');
  const gate2Record = gateCoordinator.getGate(gate2.id);
  if (gate2Record?.status !== 'rejected') throw new Error(`expected rejected, got ${gate2Record?.status}`);
  step(report, 'double-resolve-prevention', 'passed', 'second resolve correctly rejected');

  // 8. Cleanup: cleanupExpired + archiveResolved
  const expiredCount = gateCoordinator.cleanupExpired();
  const archivedCount = gateCoordinator.archiveResolved(0);
  step(report, 'cleanup-gates', 'passed', `expired=${expiredCount}, archived=${archivedCount}`);

  // 9. Verify cleanup — resolved gates should be archived away
  const afterCleanup = gateCoordinator.getGate(gate.id);
  const afterCleanup2 = gateCoordinator.getGate(gate2.id);
  if (afterCleanup || afterCleanup2) {
    step(report, 'verify-cleanup', 'failed', 'resolved gates still present after archiveResolved(0)');
  } else {
    step(report, 'verify-cleanup', 'passed', 'resolved gates removed after archive');
  }

  // 10. Teardown
  await endSession(session.id);
  step(report, 'teardown', 'passed', 'session ended');
} catch (err: unknown) {
  step(report, 'gate-e2e', 'failed', messageOf(err));
} finally {
  _setDataDirForTest(null);
  report.finishedAt = new Date().toISOString();
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  process.stdout.write(`\nReport: ${reportPath}\n`);
  process.exit(report.steps.some((s) => s.status === 'failed') ? 1 : 0);
}
