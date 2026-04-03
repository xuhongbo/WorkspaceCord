import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const queuePath = '/tmp/workspacecord-hook-events.jsonl';
const scriptPath = join(process.cwd(), '.claude', 'hooks', 'workspacecord-hook.cjs');
const failureLogPath = (home: string) => join(home, '.workspacecord', 'hook-failures.log');

const tempHomes: string[] = [];

describe('workspacecord Claude hook script', () => {
  const cleanupQueue = () => {
    if (existsSync(queuePath)) {
      unlinkSync(queuePath);
    }
  };

  beforeEach(() => {
    cleanupQueue();
  });

  afterEach(() => {
    cleanupQueue();
    while (tempHomes.length > 0) {
      const home = tempHomes.pop()!;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('直报失败时写入降级队列和失败日志', () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const result = spawnSync('node', [scriptPath, 'SessionStart'], {
      input: JSON.stringify({
        session_id: 'claude-session-1',
        cwd: '/repo',
      }),
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_URL: 'http://127.0.0.1:65531/hook-event',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(queuePath)).toBe(true);

    const lines = readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const event = JSON.parse(lines[lines.length - 1]) as {
      event: string;
      sessionId: string;
      metadata: { cwd: string };
    };
    expect(event.event).toBe('SessionStart');
    expect(event.sessionId).toBe('claude-session-1');
    expect(event.metadata.cwd).toBe('/repo');

    expect(existsSync(failureLogPath(home))).toBe(true);
    const failureLine = readFileSync(failureLogPath(home), 'utf8').trim().split('\n').pop();
    const failure = JSON.parse(failureLine || '{}') as { event: string; session_id: string; cwd: string };
    expect(failure.event).toBe('SessionStart');
    expect(failure.session_id).toBe('claude-session-1');
    expect(failure.cwd).toBe('/repo');
  });

  it('守护进程可达时优先直报，不写入队列', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const requests: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        requests.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const canBind = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      server.once('error', (err) => {
        if (settled) return;
        settled = true;
        if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EACCES') {
          resolve(false);
          return;
        }
        reject(err);
      });
      server.listen(0, '127.0.0.1', () => {
        if (settled) return;
        settled = true;
        resolve(true);
      });
    });
    if (!canBind) {
      server.close(() => {});
      console.warn('跳过网络受限环境下的守护进程可达测试');
      return;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('测试服务器端口获取失败');
    }
    const port = address.port;

    const child = spawn('node', [scriptPath, 'SessionStart'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_URL: `http://127.0.0.1:${port}/hook-event`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(
      JSON.stringify({
        session_id: 'claude-session-2',
        cwd: '/repo-2',
      }),
    );
    child.stdin.end();

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(result.code).toBe(0);
    expect(requests.length).toBe(1);
    const payload = JSON.parse(requests[0]) as {
      type: string;
      sessionId: string;
      source: string;
      metadata?: { cwd?: string; hookEvent?: string };
    };
    expect(payload.type).toBe('session_started');
    expect(payload.sessionId).toBe('claude-session-2');
    expect(payload.source).toBe('claude');
    expect(payload.metadata?.cwd).toBe('/repo-2');
    expect(payload.metadata?.hookEvent).toBe('SessionStart');

    expect(existsSync(queuePath)).toBe(false);
    expect(existsSync(failureLogPath(home))).toBe(false);
  });

  it('SubagentStop 会携带子代理元数据并映射为 completed', () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const result = spawnSync('node', [scriptPath, 'SubagentStop'], {
      input: JSON.stringify({
        session_id: 'claude-parent',
        cwd: '/repo',
        agent_id: 'agent-1',
        agent_type: 'Explore',
      }),
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_URL: 'http://127.0.0.1:65531/hook-event',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(queuePath)).toBe(true);

    const lines = readFileSync(queuePath, 'utf8').trim().split('\n').filter(Boolean);
    const event = JSON.parse(lines[lines.length - 1]) as {
      event: string;
      state: string;
      sessionId: string;
      metadata: {
        cwd: string;
        subagent?: {
          parentProviderSessionId: string;
          agentId: string;
          agentType?: string;
        };
      };
    };

    expect(event.event).toBe('SubagentStop');
    expect(event.state).toBe('completed');
    expect(event.sessionId).toBe('claude-parent');
    expect(event.metadata.cwd).toBe('/repo');
    expect(event.metadata.subagent).toEqual({
      parentProviderSessionId: 'claude-parent',
      agentId: 'agent-1',
      agentType: 'Explore',
    });
  });
});
