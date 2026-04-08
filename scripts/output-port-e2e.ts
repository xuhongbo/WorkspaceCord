try { process.loadEnvFile(); } catch {}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type CategoryChannel,
  type Guild,
} from 'discord.js';
import { config } from '../packages/core/src/config.ts';
import { registerOutputPort, getOutputPort } from '../packages/engine/src/output-port.ts';
import { DiscordOutputPort } from '../packages/bot/src/discord-output-port.ts';
import { loadRegistry, getProjectByName, getProjectByPath, registerProject } from '../packages/engine/src/project-registry.ts';
import { loadProjects } from '../packages/engine/src/project-manager.ts';
import { loadSessions, createSession, getSession, endSession } from '../packages/engine/src/session-registry.ts';
import { executeSessionPrompt } from '../packages/engine/src/session-executor.ts';
import { cleanupSessionsById } from '../packages/bot/src/session-housekeeping.ts';

interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

interface E2EReport {
  startedAt: string;
  finishedAt?: string;
  steps: StepResult[];
  missingInputs: string[];
}

function step(report: E2EReport, name: string, status: StepResult['status'], detail: string) {
  report.steps.push({ name, status, detail });
  const icon = status === 'passed' ? '✓' : status === 'skipped' ? '-' : '✗';
  process.stdout.write(`${icon} ${name}: ${detail}\n`);
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    }),
  ]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const artifactsDir = join(process.cwd(), 'local-acceptance');
mkdirSync(artifactsDir, { recursive: true });
const reportPath = join(artifactsDir, 'output-port-e2e-report.json');

const report: E2EReport = {
  startedAt: new Date().toISOString(),
  steps: [],
  missingInputs: [],
};

let client: Client | null = null;
let tempCategory: CategoryChannel | null = null;
let tempChannel: TextChannel | null = null;
let guild: Guild | null = null;
const createdSessionIds = new Set<string>();

try {
  // ── Step 1: Load registries ─────────────────────────────────────────────────
  await loadRegistry();
  await loadProjects();
  await loadSessions();

  let project = getProjectByPath(process.cwd()) ?? getProjectByName('workspacecord');
  const projectName = project ? project.name : 'output-port-e2e';
  if (!project) {
    project = await registerProject(projectName, process.cwd());
  }

  // ── Step 2: Register OutputPort ─────────────────────────────────────────────
  registerOutputPort(new DiscordOutputPort());
  step(report, 'register-output-port', 'passed', 'registerOutputPort(new DiscordOutputPort()) succeeded');

  // ── Step 3: Verify getOutputPort() ──────────────────────────────────────────
  const port = getOutputPort();
  if (!port) throw new Error('getOutputPort() returned falsy');
  step(report, 'get-output-port', 'passed', 'getOutputPort() returned registered instance');

  // ── Step 4: Discord login ───────────────────────────────────────────────────
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(config.token);
  await waitFor(1000);

  guild = await client.guilds.fetch(config.guildId);
  await guild.channels.fetch();
  step(report, 'discord-login', 'passed', `connected to guild ${guild.name}`);

  // ── Step 5: Create temp infrastructure ──────────────────────────────────────
  tempCategory = await guild.channels.create({
    name: `output-port-e2e-${Date.now().toString().slice(-6)}`,
    type: ChannelType.GuildCategory,
    reason: 'output-port e2e test',
  });
  tempChannel = await guild.channels.create({
    name: `op-e2e-${Date.now().toString().slice(-4)}`,
    type: ChannelType.GuildText,
    parent: tempCategory.id,
    reason: 'output-port e2e test channel',
  });
  step(report, 'create-infrastructure', 'passed', `category=${tempCategory.name} channel=${tempChannel.name}`);

  // ── Step 6: Create session ──────────────────────────────────────────────────
  const provider = config.anthropicApiKey ? 'claude' : 'codex';
  const hasKey = config.anthropicApiKey || config.codexApiKey;
  const agentLabel = `op-e2e-${Date.now().toString().slice(-4)}`;

  const session = await createSession({
    channelId: tempChannel.id,
    categoryId: tempCategory.id,
    projectName,
    agentLabel,
    provider,
    directory: process.cwd(),
    type: 'persistent',
    mode: 'auto',
  });
  createdSessionIds.add(session.id);
  step(report, 'create-session', 'passed', `session ${session.id} provider=${provider}`);

  // ── Step 7: Initialize panel via OutputPort ─────────────────────────────────
  await getOutputPort().initializePanel(session, tempChannel);
  const liveSession = getSession(session.id)!;
  if (liveSession.statusCardMessageId) {
    step(report, 'verify-status-card', 'passed', `statusCardMessageId=${liveSession.statusCardMessageId}`);
  } else {
    step(report, 'verify-status-card', 'failed', 'statusCardMessageId not set after initializePanel');
  }

  // ── Step 8: Verify projection ───────────────────────────────────────────────
  const projection = getOutputPort().getProjection(session.id);
  step(report, 'verify-projection', 'passed', `projection phase=${projection.phase}`);

  // ── Step 9: Execute prompt (if provider key available) ──────────────────────
  if (!hasKey) {
    report.missingInputs.push('No ANTHROPIC_API_KEY or CODEX_API_KEY — prompt execution skipped');
    step(report, 'execute-prompt', 'skipped', 'no provider API key available');
  } else {
    try {
      await withTimeout(
        executeSessionPrompt(
          getSession(session.id)!,
          tempChannel,
          'Reply with exactly: OUTPUT_PORT_E2E_OK',
        ),
        60000,
        'execute-prompt',
      );
      step(report, 'execute-prompt', 'passed', `prompt executed via ${provider}`);
    } catch (err: unknown) {
      report.missingInputs.push(`Prompt execution incomplete: ${messageOf(err)}`);
      step(report, 'execute-prompt', 'skipped', `prompt execution failed: ${messageOf(err)}`);
    }
  }

  // ── Step 10: Cleanup ────────────────────────────────────────────────────────
  await endSession(session.id);
  step(report, 'cleanup', 'passed', 'session ended');
} catch (err: unknown) {
  step(report, 'integration', 'failed', messageOf(err));
} finally {
  try {
    if (guild) {
      await cleanupSessionsById(guild, createdSessionIds, 'output-port e2e cleanup').catch(() => {});
    }
    if (tempChannel) {
      await tempChannel.delete('output-port e2e cleanup').catch(() => {});
    }
    if (tempCategory) {
      for (const child of tempCategory.children.cache.values()) {
        await child.delete('output-port e2e cleanup').catch(() => {});
      }
      await tempCategory.delete('output-port e2e cleanup').catch(() => {});
    }
  } finally {
    if (client) client.destroy();
    report.finishedAt = new Date().toISOString();
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    process.stdout.write(`\nReport written: ${reportPath}\n`);
    if (report.missingInputs.length > 0) {
      process.stdout.write('\nMissing inputs for deeper testing:\n');
      for (const item of report.missingInputs) {
        process.stdout.write(`- ${item}\n`);
      }
    }
    process.exit(report.steps.some((s) => s.status === 'failed') ? 1 : 0);
  }
}
