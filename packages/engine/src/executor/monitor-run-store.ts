// MonitorRun 持久化 — P3b
//
// 旧状态散在 ThreadSession.workflowState(iteration / lastHook / lastMonitorDecision / nextProofContract)。
// 该字段由 sessions.json 承载,与其它大量 session 字段耦合在一起。
//
// P3b 把 monitor 迭代的可恢复状态抽成独立的 MonitorRun 记录:
//   - 单次 goal 对应一个 MonitorRun
//   - 每轮迭代结束(成功/失败/阻塞/决策更新)都 checkpoint 一次
//   - Bot 重启后可列出 runningRuns,决定是否自动续跑(当前 phase 只持久化,不自动恢复)
//
// Repository 写入 debounce=0,因为调用频率低(每轮 N 秒一次)且每次都值得立即落盘。

import { JsonFileRepository } from '@workspacecord/core';
import type { Repository } from '@workspacecord/core';

export interface MonitorRun extends Record<string, unknown> {
  /** 主键:`${sessionId}:${startedAt}`。同一 session 允许多次串行的 run 留痕。 */
  id: string;
  sessionId: string;
  goal: string;
  iteration: number;
  maxIterations: number;
  status: 'running' | 'completed' | 'blocked' | 'failed' | 'abandoned';
  startedAt: number;
  lastCheckpointAt: number;
  /** 最近一次 monitor 决策的 rationale,便于排查。 */
  lastRationale?: string;
  /** 最近一次 worker pass 的 summary。 */
  lastWorkerSummary?: string;
}

const monitorRepo: Repository<MonitorRun> = new JsonFileRepository<MonitorRun>({
  filename: 'monitor-runs.json',
  idField: 'id',
  debounceMs: 0,
});

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  await monitorRepo.init();
  initialized = true;
}

function makeId(sessionId: string, startedAt: number): string {
  // 同一 session 在同一毫秒内可能多次 begin(测试中尤其常见),
  // 加 6 位随机后缀保证唯一。
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${sessionId}:${startedAt}:${suffix}`;
}

/**
 * 开始一次新的 monitor run;返回已持久化的记录。
 * 若同一 session 存在 running 的 run,旧 run 标记为 abandoned。
 */
export async function beginMonitorRun(params: {
  sessionId: string;
  goal: string;
  maxIterations: number;
}): Promise<MonitorRun> {
  await ensureInit();
  const now = Date.now();

  // 标记该 session 之前还在 running 的 run 为 abandoned(多种情况下可能出现:崩溃重启 / 重启后调用 beginMonitorRun)
  const stale = monitorRepo.find({
    where: { sessionId: params.sessionId, status: 'running' },
  });
  for (const old of stale) {
    await monitorRepo.update(old.id, { status: 'abandoned', lastCheckpointAt: now });
  }

  const run: MonitorRun = {
    id: makeId(params.sessionId, now),
    sessionId: params.sessionId,
    goal: params.goal,
    iteration: 0,
    maxIterations: params.maxIterations,
    status: 'running',
    startedAt: now,
    lastCheckpointAt: now,
  };
  await monitorRepo.save(run);
  return run;
}

export async function checkpointMonitorRun(
  runId: string,
  patch: Partial<Pick<MonitorRun, 'iteration' | 'lastRationale' | 'lastWorkerSummary'>>,
): Promise<MonitorRun | undefined> {
  await ensureInit();
  return monitorRepo.update(runId, { ...patch, lastCheckpointAt: Date.now() });
}

export async function finishMonitorRun(
  runId: string,
  status: Exclude<MonitorRun['status'], 'running'>,
  finalPatch: Partial<Pick<MonitorRun, 'lastRationale' | 'lastWorkerSummary' | 'iteration'>> = {},
): Promise<void> {
  await ensureInit();
  await monitorRepo.update(runId, {
    ...finalPatch,
    status,
    lastCheckpointAt: Date.now(),
  });
}

export async function listRunningMonitorRuns(): Promise<MonitorRun[]> {
  await ensureInit();
  return monitorRepo.find({ where: { status: 'running' } });
}

export async function getMonitorRun(runId: string): Promise<MonitorRun | undefined> {
  await ensureInit();
  return monitorRepo.get(runId);
}

export async function listMonitorRunsForSession(sessionId: string): Promise<MonitorRun[]> {
  await ensureInit();
  return monitorRepo.find({ where: { sessionId } });
}

/**
 * Bot 启动时调用:把所有历史 running 的 run 标记为 abandoned,避免悬挂。
 * 返回被标记的 run 列表,供上层决定是否续跑或通知用户。
 */
export async function reconcileMonitorRunsOnStartup(): Promise<MonitorRun[]> {
  await ensureInit();
  const running = monitorRepo.find({ where: { status: 'running' } });
  const now = Date.now();
  for (const run of running) {
    await monitorRepo.update(run.id, { status: 'abandoned', lastCheckpointAt: now });
  }
  return running;
}

/** 测试工具。 */
export function _getMonitorRunRepo(): Repository<MonitorRun> {
  return monitorRepo;
}
