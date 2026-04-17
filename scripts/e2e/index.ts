try {
  process.loadEnvFile();
} catch {
  /* optional */
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordE2EHarness } from './harness/harness.ts';
import { artifactsDirFor } from './harness/artifacts.ts';

type FeatureModule = { run: (harness: DiscordE2EHarness) => Promise<void> };

interface FeatureSpec {
  name: string;
  load: () => Promise<FeatureModule>;
}

const FEATURES: FeatureSpec[] = [
  {
    name: 'terminal-reason',
    load: () => import('./features/terminal-reason.e2e.ts'),
  },
  {
    name: 'todo-list',
    load: () => import('./features/todo-list.e2e.ts'),
  },
  {
    name: 'permission-denied',
    load: () => import('./features/permission-denied.e2e.ts'),
  },
  {
    name: 'batch-approval',
    load: () => import('./features/batch-approval.e2e.ts'),
  },
];

interface Result {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
}

function parseArgs(): { only?: string[] } {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  if (onlyArg) {
    return { only: onlyArg.slice('--only='.length).split(',') };
  }
  return {};
}

async function main() {
  const { only } = parseArgs();
  const selected = only ? FEATURES.filter((f) => only.includes(f.name)) : FEATURES;

  process.stdout.write(`[e2e] booting harness for ${selected.length} feature(s)\n`);
  const harness = await DiscordE2EHarness.boot();
  process.stdout.write(`[e2e] runId=${harness.runId} guild=${harness.guild.name}\n`);

  const results: Result[] = [];

  try {
    for (const spec of selected) {
      process.stdout.write(`\n=== ${spec.name} ===\n`);
      const start = Date.now();
      try {
        const mod = await spec.load();
        await mod.run(harness);
        const duration = Date.now() - start;
        results.push({ name: spec.name, status: 'passed', durationMs: duration });
        process.stdout.write(`[e2e] ✓ ${spec.name} (${duration}ms)\n`);
      } catch (err) {
        const duration = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          name: spec.name,
          status: 'failed',
          durationMs: duration,
          error: message,
        });
        process.stderr.write(`[e2e] ✗ ${spec.name} — ${message}\n`);
        await harness.snapshotOnFail(`${spec.name}-fail`);
        if (process.env.E2E_STOP_ON_FAIL === '1') break;
      }
    }
  } finally {
    const reportDir = artifactsDirFor(harness.runId, 'report');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'summary.json'),
      JSON.stringify(
        {
          runId: harness.runId,
          startedAt: harness.startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          results,
        },
        null,
        2,
      ),
      'utf-8',
    );
    process.stdout.write(`[e2e] report written: ${reportDir}/summary.json\n`);

    const failed = results.filter((r) => r.status === 'failed');
    const keepOnFail = process.env.E2E_KEEP_ON_FAIL === '1' && failed.length > 0;
    await harness.dispose({ keepOnFail });
    process.exit(failed.length > 0 ? 1 : 0);
  }
}

void main().catch((err) => {
  console.error('[e2e] fatal harness error:', err);
  process.exit(1);
});
