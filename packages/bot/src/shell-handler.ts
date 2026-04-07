import { execa } from 'execa';
import type { SessionChannel } from './discord-types.ts';
import type { ShellProcess } from '@workspacecord/core';
import {
  initializeSessionPanel,
  updateSessionState,
  queueDigest,
  flushDigest,
  handleResultEvent,
} from './panel-adapter.ts';
import { truncate } from '@workspacecord/core';

const runningProcesses = new Map<number, ShellProcess>();
const execaProcesses = new Map<number, ReturnType<typeof execa>>();
let pidCounter = 0;

const TIMEOUT_MS = 60_000;
function renderShellOutput(command: string, output: string): string {
  const display = output || '(no output)';
  return `\`\`\`\n$ ${command}\n${display}\n\`\`\``;
}

export async function executeShellCommand(
  command: string,
  cwd: string,
  channel: SessionChannel,
): Promise<void> {
  const pid = ++pidCounter;

  const child = execa('bash', ['-lc', command], {
    cwd,
    env: process.env,
    reject: false,
    timeout: TIMEOUT_MS,
    all: true,
  });

  const shellProcess: ShellProcess = {
    pid,
    command,
    startedAt: Date.now(),
    process: child as unknown as ShellProcess['process'],
  };

  runningProcesses.set(pid, shellProcess);
  execaProcesses.set(pid, child);
  const shellSessionId = `shell-${pid}`;

  await initializeSessionPanel(shellSessionId, channel, {
    initialTurn: 1,
    phase: '执行 shell 命令',
  });
  await updateSessionState(
    shellSessionId,
    {
      type: 'work_started',
      sessionId: shellSessionId,
      source: 'codex',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { summary: `正在执行：${truncate(command, 120)}` },
    },
  );
  queueDigest(shellSessionId, {
    kind: 'command',
    text: `执行命令：${truncate(command, 120)}`,
  });

  const result = await child;
  const output = [
    result.all?.trim() || '',
    result.timedOut ? '[Timed out after 60s]' : '',
    `[Exit code: ${result.exitCode ?? 'killed'}]`,
  ]
    .filter(Boolean)
    .join('\n');

  runningProcesses.delete(pid);
  execaProcesses.delete(pid);
  queueDigest(shellSessionId, {
    kind: 'command',
    text: `命令结束：退出码 ${result.exitCode ?? 'killed'}`,
  });
  await flushDigest(shellSessionId);
  await handleResultEvent(
    shellSessionId,
    {
      type: 'result',
      success: result.exitCode === 0,
      costUsd: 0,
      durationMs: Date.now() - shellProcess.startedAt,
      numTurns: 1,
      errors: result.exitCode === 0 ? [] : [output],
      metadata: { sessionEnd: false },
    },
    renderShellOutput(command, output),
  );
}

export function listProcesses(): ShellProcess[] {
  return Array.from(runningProcesses.values());
}

export function killProcess(pid: number): boolean {
  const proc = execaProcesses.get(pid);
  if (!proc) return false;
  proc.kill('SIGTERM');
  execaProcesses.delete(pid);
  runningProcesses.delete(pid);
  return true;
}
