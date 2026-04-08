try { process.loadEnvFile(); } catch { /* .env not required */ }

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../packages/core/src/config.ts';
import { getOutputPort } from '../packages/engine/src/output-port.ts';
import { BotServicesOrchestrator } from '../packages/bot/src/bot-services-orchestrator.ts';
import type { ServiceContainer } from '../packages/bot/src/bot-services-orchestrator.ts';

interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

interface StartupReport {
  startedAt: string;
  finishedAt?: string;
  steps: StepResult[];
}

function step(report: StartupReport, name: string, status: StepResult['status'], detail: string) {
  report.steps.push({ name, status, detail });
  const icon = status === 'passed' ? '\u2713' : status === 'skipped' ? '-' : '\u2717';
  process.stdout.write(`${icon} ${name}: ${detail}\n`);
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const artifactsDir = join(process.cwd(), 'local-acceptance');
mkdirSync(artifactsDir, { recursive: true });
const reportPath = join(artifactsDir, 'startup-flow-e2e-report.json');

const report: StartupReport = {
  startedAt: new Date().toISOString(),
  steps: [],
};

let client: Client | null = null;
let container: ServiceContainer | null = null;

try {
  // 1. Discord client login
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
  });
  await client.login(config.token);
  step(report, 'discord-login', 'passed', 'Client.login() resolved');

  // 2. Wait for ready event
  await Promise.race([
    new Promise<void>((resolve) => {
      if (client!.isReady()) return resolve();
      client!.once('ready', () => resolve());
    }),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for ready event')), 10_000),
    ),
  ]);
  step(report, 'discord-ready', 'passed', `Ready as ${client.user?.tag ?? 'unknown'}`);

  // 3. Full service setup
  const orchestrator = new BotServicesOrchestrator();
  container = await orchestrator.setupServices(client);
  step(report, 'setup-services', 'passed', 'BotServicesOrchestrator.setupServices() completed');

  // 4. Verify container fields
  const requiredFields = ['serviceBus', 'logBuffer', 'presenceManager', 'logChannel'] as const;
  const missing = requiredFields.filter((f) => !(f in container!));
  if (missing.length > 0) {
    throw new Error(`ServiceContainer missing fields: ${missing.join(', ')}`);
  }
  step(report, 'verify-container', 'passed', `All fields present: ${requiredFields.join(', ')}`);

  // 5. Verify output port registered
  const port = getOutputPort();
  if (!port) throw new Error('getOutputPort() returned falsy');
  step(report, 'verify-output-port', 'passed', 'getOutputPort() callable without throw');

  // 6. Health check (wait for services to stabilize)
  await waitFor(2000);
  const healthMap = await container.serviceBus.healthCheck();
  const serviceNames = [...healthMap.keys()].join(', ');
  step(report, 'health-check', 'passed', `healthCheck() returned ${healthMap.size} services: ${serviceNames}`);

  // 7. Shutdown services
  await container.serviceBus.stopAll();
  step(report, 'shutdown-services', 'passed', 'serviceBus.stopAll() completed');

  // 8. Cleanup client
  client.destroy();
  client = null;
  step(report, 'cleanup', 'passed', 'client.destroy() completed');
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  step(report, 'startup-flow', 'failed', message);
} finally {
  try {
    if (container) {
      await container.serviceBus.stopAll().catch(() => {});
    }
  } finally {
    if (client) client.destroy();
    report.finishedAt = new Date().toISOString();
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    process.stdout.write(`\nReport written to: ${reportPath}\n`);
    process.exit(report.steps.some((s) => s.status === 'failed') ? 1 : 0);
  }
}
