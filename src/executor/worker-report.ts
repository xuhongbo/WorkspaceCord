import { truncate } from '../utils.ts';
import type { SessionWorkerProgressReport } from '../types.ts';

export type WorkerPassResultShape = {
  text: string;
  commandCount: number;
  fileChangeCount: number;
  changedFiles: string[];
  recentCommands: string[];
  success: boolean | null;
  hadError: boolean;
  askedUser: boolean;
};

export function summarizeWorkerText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '(none)';
  return truncate(trimmed.replace(/\s+/g, ' '), 1200);
}

export function extractClaimedCompletedOutcomes(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.filter((line) => /(?:完成|implemented|done|finished|已实现|fixed|added)/i.test(line)).slice(0, 6);
}

export function extractRemainingGaps(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.filter((line) => /(?:missing|todo|remaining|left|待处理|未完成|还需)/i.test(line)).slice(0, 6);
}

export function buildWorkerProgressReport(
  goal: string,
  result: WorkerPassResultShape,
): SessionWorkerProgressReport {
  const changedFiles = result.changedFiles.slice(0, 12);
  const validationCommands = result.recentCommands.slice(0, 8);
  const meaningfulExecution = result.commandCount > 0 || result.fileChangeCount > 0;
  const blockers = result.hadError ? ['The latest pass reported an error or stalled outcome.'] : [];

  return {
    originalGoal: goal,
    textualResponse: summarizeWorkerText(result.text),
    commandCount: result.commandCount,
    fileChangeCount: result.fileChangeCount,
    meaningfulExecutionEvidence: meaningfulExecution,
    providerReportedSuccess: result.success === null ? 'unknown' : result.success ? 'yes' : 'no',
    workerErrorsObserved: result.hadError,
    askedForHumanInput: result.askedUser,
    claimedCompletedOutcomes: extractClaimedCompletedOutcomes(result.text),
    artifacts: changedFiles,
    validationCommands,
    goalAssessment: result.text.trim()
      ? truncate(result.text.trim(), 1200)
      : meaningfulExecution
        ? 'The worker executed commands or changed files but did not provide an explicit textual assessment.'
        : 'The worker did not provide a substantive assessment of progress toward the goal.',
    remainingGaps: extractRemainingGaps(result.text),
    blockers,
  };
}

export function summarizeWorkerPass(report: SessionWorkerProgressReport): string {
  const changedFiles = report.artifacts;
  const recentCommands = report.validationCommands.length > 0 ? report.validationCommands : [];
  const parts = [
    `Textual response: ${report.textualResponse}`,
    `Command executions: ${report.commandCount}`,
    `File changes: ${report.fileChangeCount}`,
    `Meaningful execution evidence: ${report.meaningfulExecutionEvidence ? 'yes' : 'no'}`,
    `Asked for human input: ${report.askedForHumanInput ? 'yes' : 'no'}`,
    `Provider reported success: ${report.providerReportedSuccess}`,
    `Worker errors observed: ${report.workerErrorsObserved ? 'yes' : 'no'}`,
  ];

  if (report.claimedCompletedOutcomes.length > 0) {
    parts.push(`Claimed completed outcomes: ${report.claimedCompletedOutcomes.join(' | ')}`);
  }
  if (report.remainingGaps.length > 0) {
    parts.push(`Remaining gaps: ${report.remainingGaps.join(' | ')}`);
  }
  if (changedFiles.length > 0) {
    parts.push(`Changed files: ${changedFiles.join(', ')}`);
  }
  if (recentCommands.length > 0) {
    parts.push(`Validation commands: ${recentCommands.join(' | ')}`);
  }
  if (report.blockers.length > 0) {
    parts.push(`Blockers: ${report.blockers.join(' | ')}`);
  }

  return parts.join('\n');
}

export function annotateInactivityAbort(text: string, timeoutMs: number): string {
  const note = `[Worker pass aborted after ${Math.round(timeoutMs / 1000)}s of inactivity.]`;
  const trimmed = text.trim();
  if (trimmed.includes(note)) return trimmed;
  return trimmed ? `${trimmed}\n\n${note}` : note;
}


export function createSyntheticResult(
  success: boolean,
  summary: string,
  sessionEnd = false,
) {
  return {
    type: 'result' as const,
    success,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
    errors: success ? [] : [summary],
    metadata: { sessionEnd },
  };
}
