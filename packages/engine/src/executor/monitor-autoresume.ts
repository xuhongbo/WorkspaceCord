// Monitor run 自动续跑编排 — P3b 后续迭代
//
// 场景:bot 崩溃/重启后,sessions.json 保留了 session 的 mode/goal/workflowState,
// monitor-runs.json 保留了最后一次 MonitorRun 的迭代快照。`reconcileMonitorRunsOnStartup`
// 已把悬挂的 running run 标记为 abandoned;本模块在此基础上按策略决定是否自动续跑。
//
// 策略边界:
//   - engine 层只负责"筛选哪些 session 应当续跑 + 分派一次 monitor continue"。
//   - channel / 通知等 Discord 细节由 bot 层在拿到候选后自行处理。
//   - 续跑采用 `executeSessionContinue` 语义(会自动基于 session.workflowState.nextProofContract
//     构造 steering prompt),而非 `executeSessionPrompt`(会被误认为新任务)。
//
// 保守原则:任何不确定(session 缺失 / 非 monitor 模式 / 没有 goal / 正在生成)都跳过。

import { getSessionView } from '../session-context.ts';
import { reconcileMonitorRunsOnStartup, type MonitorRun } from './monitor-run-store.ts';

export type MonitorAutoResumePolicy = 'abandon-only' | 'resume-with-goal';

export interface MonitorAutoResumeCandidate {
  sessionId: string;
  channelId: string;
  runId: string;
  /** 续跑时应当使用的 goal:优先 session.monitorGoal(最新),回退到 run.goal(历史)。 */
  goal: string;
  /** 上次 checkpoint 的迭代号,便于展示"从第 N 轮恢复"。 */
  lastIteration: number;
  /** 上次 monitor 决策理由,供 bot 层在日志/提示中引用。 */
  lastRationale?: string;
  /** 被中止的原始 run 记录,供调用方决定是否向用户通知。 */
  abandonedRun: MonitorRun;
}

export interface ReconcileResult {
  /** 本次启动时被标记为 abandoned 的所有 run(无论是否续跑)。 */
  abandoned: MonitorRun[];
  /** 根据策略筛选出的、建议续跑的候选。当策略为 `abandon-only` 时总为空。 */
  candidates: MonitorAutoResumeCandidate[];
}

/**
 * 一次性调用:执行 reconcile + 按策略产出候选。
 * 不触发任何续跑,调用方拿到 candidates 后自行决定如何分派。
 */
export async function reconcileAndCollectAutoResumeCandidates(
  policy: MonitorAutoResumePolicy,
): Promise<ReconcileResult> {
  const abandoned = await reconcileMonitorRunsOnStartup();
  if (policy === 'abandon-only' || abandoned.length === 0) {
    return { abandoned, candidates: [] };
  }

  const candidates: MonitorAutoResumeCandidate[] = [];
  for (const run of abandoned) {
    const session = getSessionView(run.sessionId);
    if (!session) continue;
    if (session.mode !== 'monitor') continue;
    if (session.isGenerating) continue; // 正常启动后不可能,保底
    const goal = session.monitorGoal || run.goal;
    if (!goal) continue;
    candidates.push({
      sessionId: session.id,
      channelId: session.channelId,
      runId: run.id,
      goal,
      lastIteration: run.iteration,
      lastRationale: run.lastRationale,
      abandonedRun: run,
    });
  }

  return { abandoned, candidates };
}
