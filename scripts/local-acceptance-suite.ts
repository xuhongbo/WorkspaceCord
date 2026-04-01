import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

const outDir = join(process.cwd(), 'local-acceptance');
mkdirSync(outDir, { recursive: true });

const commands = [
  { name: 'workspacecord-help', cmd: ['workspacecord', 'help'] },
  { name: 'config-list', cmd: ['workspacecord', 'config', 'list'] },
  { name: 'config-path', cmd: ['workspacecord', 'config', 'path'] },
  { name: 'project-list', cmd: ['workspacecord', 'project', 'list'] },
  { name: 'project-info', cmd: ['workspacecord', 'project', 'info'] },
  {
    name: 'integration-smoke',
    cmd: ['node', '--experimental-strip-types', 'scripts/integration-smoke.ts'],
  },
  {
    name: 'multi-session-smoke',
    cmd: ['node', '--experimental-strip-types', 'scripts/multi-session-smoke.ts'],
  },
  {
    name: 'session-sync-smoke',
    cmd: ['node', '--experimental-strip-types', 'scripts/session-sync-smoke.ts'],
  },
  { name: 'monitor-e2e', cmd: ['node', '--experimental-strip-types', 'scripts/monitor-e2e.ts'] },
];

const results: Array<{
  name: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  artifactFailure?: string;
}> = [];

function readMonitorArtifactFailure(): string | undefined {
  const resultPath = join(outDir, 'monitor-e2e-result.json');
  if (!existsSync(resultPath)) {
    return 'monitor-e2e-result.json missing';
  }
  try {
    const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
      runError?: string | null;
      completion?: string;
      proofFile?: boolean;
      proofContent?: string | null;
    };
    if (parsed.runError) return `runError: ${parsed.runError}`;
    if (parsed.completion === '(none)') return 'completion missing';
    if (parsed.proofFile !== true) return 'proof file missing';
    if (parsed.proofContent !== 'MONITOR_E2E_OK') return 'proof content mismatch';
  } catch (err) {
    return `artifact parse failed: ${(err as Error).message}`;
  }
  return undefined;
}

for (const item of commands) {
  process.stdout.write(`\n=== RUN ${item.name} ===\n`);
  const [file, ...args] = item.cmd;
  const result = await execa(file, args, {
    cwd: process.cwd(),
    reject: false,
    env: process.env,
  });
  process.stdout.write(result.stdout ? `${result.stdout}\n` : '');
  process.stderr.write(result.stderr ? `${result.stderr}\n` : '');
  const artifactFailure = item.name === 'monitor-e2e' ? readMonitorArtifactFailure() : undefined;
  results.push({
    name: item.name,
    exitCode: artifactFailure ? 1 : result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    artifactFailure,
  });
}

writeFileSync(
  join(outDir, 'acceptance-suite-report.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      results,
      failed: results.filter((item) => item.exitCode !== 0).map((item) => item.name),
    },
    null,
    2,
  ),
  'utf-8',
);

const failed = results.filter((item) => item.exitCode !== 0);
process.exit(failed.length > 0 ? 1 : 0);
