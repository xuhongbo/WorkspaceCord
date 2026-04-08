try { process.loadEnvFile(); } catch {}
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as sessions from '../packages/engine/src/session-registry.ts';
import { executeSessionPrompt } from '../packages/engine/src/session-executor.ts';

const baseDir = join(process.cwd(), 'local-acceptance', 'monitor-e2e-workspace');
mkdirSync(baseDir, { recursive: true });

const session = await sessions.createSession({
  channelId: `monitor-e2e-${Date.now()}`,
  categoryId: 'local-monitor',
  projectName: 'workspacecord-monitor-e2e',
  agentLabel: 'monitor-e2e',
  provider: 'codex',
  directory: baseDir,
  type: 'persistent',
});

sessions.setMode(session.id, 'monitor');
sessions.setMonitorGoal(
  session.id,
  'Create a file proving monitor mode can drive a task to completion.',
);

const sentMessages: string[] = [];
type MessagePayload =
  | string
  | {
      content?: string;
      embeds?: Array<{ data?: { title?: string; description?: string } }>;
    };
const channel = {
  topic: null as string | null,
  async send(payload: MessagePayload) {
    const text =
      typeof payload === 'string'
        ? payload
        : payload?.content
          ? String(payload.content)
          : payload?.embeds
              ?.map((e) => `${e.data?.title || ''}\n${e.data?.description || ''}`)
              .join('\n') || JSON.stringify(payload);
    sentMessages.push(text);
    process.stdout.write(`\n--- CHANNEL SEND ---\n${text}\n`);
    return {
      content: text,
      async edit(next: MessagePayload) {
        const edited = typeof next === 'string' ? next : next?.content || JSON.stringify(next);
        sentMessages.push(String(edited));
      },
      async delete() {},
    };
  },
  async sendTyping() {},
  async setTopic(nextTopic: string) {
    this.topic = nextTopic;
    return this;
  },
};

const prompt =
  'Create a file named monitor-proof.txt in the current working directory containing exactly MONITOR_E2E_OK, then explain what you created.';
let runError: string | null = null;
let exitCode = 0;

try {
  await Promise.race([
    executeSessionPrompt(sessions.getSession(session.id)!, channel, prompt, {
      updateMonitorGoal: true,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('monitor-e2e timeout after 120s')), 120000),
    ),
  ]);

  const files = readdirSync(baseDir);
  const result = {
    sessionId: session.id,
    baseDir,
    files,
    monitorPasses: sentMessages.filter((msg) => msg.includes('Monitor: pass')).length,
    completion: sentMessages.find((msg) => msg.includes('completion bar met')) || '(none)',
    messages: sentMessages.slice(-20),
  };

  writeFileSync(
    join(process.cwd(), 'local-acceptance', 'monitor-e2e-result.json'),
    JSON.stringify(result, null, 2),
    'utf-8',
  );

  process.stdout.write(`\n=== MONITOR E2E SUMMARY ===\n${JSON.stringify(result, null, 2)}\n`);
} catch (err: unknown) {
  runError = (err as Error).message || 'unknown error';
  exitCode = 1;
} finally {
  const proofPath = join(baseDir, 'monitor-proof.txt');
  const proofContent = existsSync(proofPath) ? readFileSync(proofPath, 'utf-8').trim() : null;
  const finalResult = {
    sessionId: session.id,
    baseDir,
    files: readdirSync(baseDir),
    monitorPasses: sentMessages.filter((msg) => msg.includes('Monitor: pass')).length,
    completion: sentMessages.find((msg) => msg.includes('completion bar met')) || '(none)',
    proofFile: existsSync(proofPath),
    proofContent,
    runError,
    messages: sentMessages.slice(-30),
  };
  if (
    runError ||
    finalResult.completion === '(none)' ||
    !finalResult.proofFile ||
    finalResult.proofContent !== 'MONITOR_E2E_OK'
  ) {
    exitCode = 1;
  }
  writeFileSync(
    join(process.cwd(), 'local-acceptance', 'monitor-e2e-result.json'),
    JSON.stringify(finalResult, null, 2),
    'utf-8',
  );
  await sessions.endSession(session.id).catch(() => {});
  process.exit(exitCode);
}
