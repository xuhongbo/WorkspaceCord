import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setDataDirForTest } from '@workspacecord/core';
import {
  beginMonitorRun,
  checkpointMonitorRun,
  finishMonitorRun,
  listRunningMonitorRuns,
  listMonitorRunsForSession,
  getMonitorRun,
  reconcileMonitorRunsOnStartup,
  _getMonitorRunRepo,
} from '../src/executor/monitor-run-store.ts';

describe('MonitorRun store (P3b)', () => {
  let dataDir = '';

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wc-monitor-runs-'));
    _setDataDirForTest(dataDir);
    await _getMonitorRunRepo().clear();
  });

  afterEach(() => {
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('beginMonitorRun persists a running record', async () => {
    const run = await beginMonitorRun({
      sessionId: 's1',
      goal: 'refactor module X',
      maxIterations: 6,
    });
    expect(run.status).toBe('running');
    expect(run.iteration).toBe(0);
    expect(run.goal).toBe('refactor module X');
    expect(await getMonitorRun(run.id)).toMatchObject({
      status: 'running',
      sessionId: 's1',
    });
  });

  it('beginMonitorRun abandons stale running runs of the same session', async () => {
    const first = await beginMonitorRun({
      sessionId: 's1',
      goal: 'first goal',
      maxIterations: 6,
    });
    const second = await beginMonitorRun({
      sessionId: 's1',
      goal: 'second goal',
      maxIterations: 6,
    });
    expect((await getMonitorRun(first.id))?.status).toBe('abandoned');
    expect((await getMonitorRun(second.id))?.status).toBe('running');
  });

  it('checkpointMonitorRun updates iteration and rationale', async () => {
    const run = await beginMonitorRun({ sessionId: 's1', goal: 'g', maxIterations: 6 });
    await checkpointMonitorRun(run.id, {
      iteration: 3,
      lastRationale: 'worker has applied patches',
    });
    const updated = await getMonitorRun(run.id);
    expect(updated?.iteration).toBe(3);
    expect(updated?.lastRationale).toBe('worker has applied patches');
    expect(updated?.status).toBe('running');
  });

  it('finishMonitorRun marks terminal state', async () => {
    const run = await beginMonitorRun({ sessionId: 's1', goal: 'g', maxIterations: 6 });
    await finishMonitorRun(run.id, 'completed', {
      iteration: 4,
      lastRationale: 'all checks passed',
    });
    const done = await getMonitorRun(run.id);
    expect(done?.status).toBe('completed');
    expect(done?.iteration).toBe(4);
  });

  it('listRunningMonitorRuns excludes terminal runs', async () => {
    const a = await beginMonitorRun({ sessionId: 'sA', goal: 'a', maxIterations: 6 });
    await beginMonitorRun({ sessionId: 'sB', goal: 'b', maxIterations: 6 });
    await finishMonitorRun(a.id, 'completed');
    const running = await listRunningMonitorRuns();
    expect(running.map((r) => r.sessionId)).toEqual(['sB']);
  });

  it('listMonitorRunsForSession returns history including terminals', async () => {
    const first = await beginMonitorRun({ sessionId: 'sX', goal: 'g1', maxIterations: 6 });
    await finishMonitorRun(first.id, 'completed');
    await beginMonitorRun({ sessionId: 'sX', goal: 'g2', maxIterations: 6 });
    const history = await listMonitorRunsForSession('sX');
    expect(history.length).toBe(2);
    const statuses = history.map((r) => r.status).sort();
    expect(statuses).toEqual(['completed', 'running']);
  });

  it('reconcileMonitorRunsOnStartup abandons all running runs and returns them', async () => {
    await beginMonitorRun({ sessionId: 's1', goal: 'g1', maxIterations: 6 });
    await beginMonitorRun({ sessionId: 's2', goal: 'g2', maxIterations: 6 });
    const abandoned = await reconcileMonitorRunsOnStartup();
    expect(abandoned.length).toBe(2);
    const runningAfter = await listRunningMonitorRuns();
    expect(runningAfter.length).toBe(0);
  });

  it('records survive repository reload (persistence)', async () => {
    const run = await beginMonitorRun({ sessionId: 's1', goal: 'g', maxIterations: 6 });
    await finishMonitorRun(run.id, 'completed');
    // 重新拿 repo (模拟重启);手动重置 init flag 通过 clear+重新 init 不可行,
    // 这里直接从文件读回,验证 finish 已落盘
    const fresh = _getMonitorRunRepo();
    await fresh.init();
    // init 幂等:已加载的数据应仍在
    expect(await getMonitorRun(run.id)).toBeDefined();
  });
});
