import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.ts';
import { getAllRegisteredProjects, loadRegistry } from '../src/project-registry.ts';
import { loadSessions, getAllSessions } from '../src/thread-manager.ts';
import { listCodexSessionsForProjects } from '../src/codex-session-discovery.ts';
import { startSync, stopSync } from '../src/session-sync.ts';
import { cleanupSessionsById } from '../src/session-housekeeping.ts';

const outDir = join(process.cwd(), 'local-acceptance');
mkdirSync(outDir, { recursive: true });
const reportPath = join(outDir, 'session-sync-report.json');

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms)),
  ]);
}

await loadRegistry();
await loadSessions();

const projects = getAllRegisteredProjects();
const boundProjects = projects.filter((project) => project.discordCategoryId);

const discoveredClaude: Array<{ project: string; sessionId: string; summary?: string }> = [];
try {
  const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
  for (const project of projects) {
    try {
      const sessions = await withTimeout(
        claudeSdk.listSessions({ dir: project.path, limit: 20 }),
        10000,
        `claude-listSessions:${project.name}`,
      );
      discoveredClaude.push(
        ...sessions
          .filter((item) => item?.sessionId)
          .map((item) => ({
            project: project.name,
            sessionId: item.sessionId,
            summary: item.summary || item.firstPrompt,
          })),
      );
    } catch {
      // ignore one project
    }
  }
} catch {
  // sdk unavailable
}

const discoveredCodex = listCodexSessionsForProjects(projects.map((project) => project.path)).map(
  (item) => ({
    projectPath: item.projectPath,
    sessionId: item.id,
    threadName: item.threadName,
    cwd: item.cwd,
  }),
);

const before = getAllSessions().length;
const beforeChannelIds = new Set(getAllSessions().map((session) => session.channelId));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(config.token);
const guild = await client.guilds.fetch(config.guildId);
await guild.channels.fetch();
startSync(client);
await new Promise((resolve) => setTimeout(resolve, 5000));
stopSync();
const sessionsAfterSync = getAllSessions();
const after = sessionsAfterSync.length;
const addedSessionIds = sessionsAfterSync
  .filter((session) => !beforeChannelIds.has(session.channelId))
  .map((session) => session.id);
const cleanup = await cleanupSessionsById(
  guild,
  addedSessionIds,
  'workspacecord session-sync smoke cleanup',
);
client.destroy();

const report = {
  projects: projects.map((project) => ({
    name: project.name,
    path: project.path,
    discordCategoryId: project.discordCategoryId || null,
  })),
  boundProjects: boundProjects.length,
  discoveredClaudeCount: discoveredClaude.length,
  discoveredClaude,
  discoveredCodexCount: discoveredCodex.length,
  discoveredCodex,
  inMemorySessionsBeforeSync: before,
  inMemorySessionsAfterSync: after,
  syncAddedSessions: after - before,
  cleanup,
};

writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);
