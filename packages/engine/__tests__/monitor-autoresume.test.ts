import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileAndCollectAutoResumeCandidates, beginMonitorRun } from '../src/index.ts';
import { _getMonitorRunRepo } from '../src/executor/monitor-run-store.ts';
import * as registry from '../src/session-registry.ts';
import type { ThreadSession } from '@workspacecord/core';

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    id: 's1',
    channelId: 'ch1',
    categoryId: 'cat1',
    projectName: 'p',
    agentLabel: 'a',
    provider: 'claude',
    type: 'persistent',
    directory: '/tmp',
    mode: 'monitor',
    agentPersona: undefined,
    verbose: false,
    subagentDepth: 0,
    monitorGoal: 'fix the bug',
    monitorProviderSessionId: undefined,
    workflowState: { status: 'idle', iteration: 0, updatedAt: Date.now() },
    isGenerating: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    totalCost: 0,
    currentTurn: 0,
    humanResolved: false,
    discoverySource: 'discord',
    ...overrides,
  } as ThreadSession;
}

describe('reconcileAndCollectAutoResumeCandidates', () => {
  let getSessionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await _getMonitorRunRepo().clear();
    getSessionSpy = vi.spyOn(registry, 'getSession');
  });

  afterEach(() => {
    getSessionSpy.mockRestore();
  });

  it('abandon-only: reconciles abandoned runs but returns no candidates', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: 'g1', maxIterations: 6 });
    getSessionSpy.mockReturnValue(makeSession());

    const result = await reconcileAndCollectAutoResumeCandidates('abandon-only');
    expect(result.abandoned).toHaveLength(1);
    expect(result.candidates).toHaveLength(0);
  });

  it('resume-with-goal: returns candidate when session is monitor + has goal + not generating', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: 'persisted-goal', maxIterations: 6 });
    getSessionSpy.mockReturnValue(makeSession({ monitorGoal: 'live-goal' }));

    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.abandoned).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sessionId: 's1',
      channelId: 'ch1',
      goal: 'live-goal', // 活的 monitorGoal 优先于历史 run.goal
    });
  });

  it('resume-with-goal: falls back to run.goal when session has no monitorGoal', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: 'persisted-goal', maxIterations: 6 });
    getSessionSpy.mockReturnValue(makeSession({ monitorGoal: undefined }));

    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].goal).toBe('persisted-goal');
  });

  it('resume-with-goal: skips sessions that no longer exist', async () => {
    await beginMonitorRun({ sessionId: 's-gone', goal: 'g', maxIterations: 6 });
    getSessionSpy.mockReturnValue(undefined);

    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.abandoned).toHaveLength(1);
    expect(result.candidates).toHaveLength(0);
  });

  it('resume-with-goal: skips sessions not in monitor mode', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: 'g', maxIterations: 6 });
    getSessionSpy.mockReturnValue(makeSession({ mode: 'auto' }));

    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.candidates).toHaveLength(0);
  });

  it('resume-with-goal: skips sessions with neither live goal nor run.goal', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: '', maxIterations: 6 });
    getSessionSpy.mockReturnValue(makeSession({ monitorGoal: undefined }));

    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.candidates).toHaveLength(0);
  });

  it('resume-with-goal: skips sessions currently generating(保底)', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: 'g', maxIterations: 6 });
    getSessionSpy.mockReturnValue(makeSession({ isGenerating: true }));

    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.candidates).toHaveLength(0);
  });

  it('returns empty when no abandoned runs exist', async () => {
    const result = await reconcileAndCollectAutoResumeCandidates('resume-with-goal');
    expect(result.abandoned).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(getSessionSpy).not.toHaveBeenCalled();
  });
});
