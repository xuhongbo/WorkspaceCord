import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const SOCKET_PATH = '/tmp/workspacecord-test.sock';
const scriptPath = join(process.cwd(), '.claude', 'hooks', 'workspacecord-hook.cjs');
const failureLogPath = (home: string) => join(home, '.workspacecord', 'hook-failures.log');
const queuePath = (home: string) => join(home, '.workspacecord', 'hook-queue.jsonl');

const tempHomes: string[] = [];

describe('workspacecord Claude hook script', () => {
  const cleanupSocket = () => {
    if (existsSync(SOCKET_PATH)) {
      try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
    }
  };

  beforeEach(() => {
    cleanupSocket();
  });

  afterEach(() => {
    cleanupSocket();
    while (tempHomes.length > 0) {
      const home = tempHomes.pop()!;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('socket 不可达时写入失败日志', () => {
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
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(failureLogPath(home))).toBe(true);
    const failureLine = readFileSync(failureLogPath(home), 'utf8').trim().split('\n').pop();
    const failure = JSON.parse(failureLine || '{}') as { event: string; session_id: string; cwd: string };
    expect(failure.event).toBe('SessionStart');
    expect(failure.session_id).toBe('claude-session-1');
    expect(failure.cwd).toBe('/repo');
  });

  it('socket 可达时优先直报', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const messages: string[] = [];
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        messages.push(data.toString().trim());
      });
      socket.on('end', () => socket.end());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, () => resolve());
    });

    const child = spawn('node', [scriptPath, 'SessionStart'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
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
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(result.code).toBe(0);
    expect(messages.length).toBe(1);

    const payload = JSON.parse(messages[0]) as {
      type: string;
      payload: { sessionId: string; source: string; metadata?: { cwd?: string; hookEvent?: string } };
    };
    expect(payload.type).toBe('hook-event');
    expect(payload.payload.sessionId).toBe('claude-session-2');
    expect(payload.payload.source).toBe('claude');
    expect(payload.payload.metadata?.cwd).toBe('/repo-2');
    expect(payload.payload.metadata?.hookEvent).toBe('SessionStart');

    expect(existsSync(failureLogPath(home))).toBe(false);
  });

  it('SubagentStop 会携带子代理元数据', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const messages: string[] = [];
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        messages.push(data.toString().trim());
      });
      socket.on('end', () => socket.end());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, () => resolve());
    });

    const child = spawn('node', [scriptPath, 'SubagentStop'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(
      JSON.stringify({
        session_id: 'claude-session-3',
        cwd: '/repo-3',
        agent_id: 'sub-1',
        agent_type: 'test-agent',
      }),
    );
    child.stdin.end();

    const result = await new Promise<{ code: number | null }>((resolve) => {
      child.on('close', (code) => resolve({ code }));
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(result.code).toBe(0);
    expect(messages.length).toBe(1);

    const payload = JSON.parse(messages[0]) as {
      type: string;
      payload: { sessionId: string; metadata?: { subagent?: { agentId: string; agentType: string } } };
    };
    expect(payload.payload.sessionId).toBe('claude-session-3');
    expect(payload.payload.metadata?.subagent?.agentId).toBe('sub-1');
    expect(payload.payload.metadata?.subagent?.agentType).toBe('test-agent');
  });

  it('socket 不可达时写入队列文件', () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const result = spawnSync('node', [scriptPath, 'SessionStart'], {
      input: JSON.stringify({
        session_id: 'claude-session-q1',
        cwd: '/repo-q',
      }),
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(existsSync(queuePath(home))).toBe(true);
    const queueLine = readFileSync(queuePath(home), 'utf8').trim().split('\n').pop();
    const entry = JSON.parse(queueLine || '{}') as {
      sessionId: string; type: string; retry_count: number;
    };
    expect(entry.sessionId).toBe('claude-session-q1');
    expect(entry.type).toBe('session_started');
    expect(entry.retry_count).toBe(0);
  });

  it('drain 模式成功发送队列条目并清空文件', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    // Pre-populate queue with 2 entries
    const wsDir = join(home, '.workspacecord');
    mkdirSync(wsDir, { recursive: true });
    const qFile = queuePath(home);
    writeFileSync(qFile, [
      JSON.stringify({ type: 'session_started', sessionId: 's1', source: 'claude', confidence: 'high', timestamp: 1, retry_count: 0 }),
      JSON.stringify({ type: 'completed', sessionId: 's2', source: 'claude', confidence: 'high', timestamp: 2, retry_count: 0 }),
    ].join('\n') + '\n');

    const messages: string[] = [];
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        messages.push(data.toString().trim());
      });
      socket.on('end', () => socket.end());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, () => resolve());
    });

    let exitCode: number | null = null;
    await new Promise<void>((resolve) => {
      const child = spawn('node', [scriptPath, '--drain'], {
        env: {
          ...process.env,
          HOME: home,
          workspacecord_HOOK_SOCKET: SOCKET_PATH,
        },
      });
      child.on('close', (code) => {
        exitCode = code;
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(exitCode).toBe(0);
    expect(messages.length).toBe(2);

    // Queue file should be deleted after successful drain
    expect(existsSync(qFile)).toBe(false);
  });

  it('drain 递增 retry_count 并保留失败条目', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const wsDir = join(home, '.workspacecord');
    mkdirSync(wsDir, { recursive: true });
    const qFile = queuePath(home);
    // One entry that will fail (no socket)
    writeFileSync(qFile, [
      JSON.stringify({ type: 'session_started', sessionId: 's3', source: 'claude', confidence: 'high', timestamp: 3, retry_count: 1 }),
    ].join('\n') + '\n');

    const result = spawnSync('node', [scriptPath, '--drain'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const remaining = readFileSync(qFile, 'utf8').trim().split('\n').map(JSON.parse);
    expect(remaining.length).toBe(1);
    expect(remaining[0].retry_count).toBe(2);
  });

  it('超过 MAX_RETRY 的条目在 drain 时被跳过', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const wsDir = join(home, '.workspacecord');
    mkdirSync(wsDir, { recursive: true });
    const qFile = queuePath(home);
    writeFileSync(qFile, [
      JSON.stringify({ type: 'session_started', sessionId: 's4', source: 'claude', confidence: 'high', timestamp: 4, retry_count: 3 }),
    ].join('\n') + '\n');

    const result = spawnSync('node', [scriptPath, '--drain'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    // File should be deleted since all entries were either skipped or consumed
    expect(existsSync(qFile)).toBe(false);
  });

  it('配置 HOOK_SECRET 时 secret 位于消息信封顶层而非 payload 内', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const messages: string[] = [];
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        messages.push(data.toString().trim());
      });
      socket.on('end', () => socket.end());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, () => resolve());
    });

    const child = spawn('node', [scriptPath, 'SessionStart'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
        workspacecord_HOOK_SECRET: 'my-test-secret',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(
      JSON.stringify({
        session_id: 'claude-session-secret',
        cwd: '/repo-secret',
      }),
    );
    child.stdin.end();

    await new Promise<{ code: number | null }>((resolve) => {
      child.on('close', (code) => resolve({ code }));
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(messages.length).toBe(1);

    const msg = JSON.parse(messages[0]) as {
      type: string;
      secret?: string;
      payload: { sessionId: string; secret?: string };
    };
    expect(msg.type).toBe('hook-event');
    // secret MUST be at the envelope level for ipc-server.ts validation
    expect(msg.secret).toBe('my-test-secret');
    // secret MUST NOT leak into the payload
    expect(msg.payload.secret).toBeUndefined();
    expect(msg.payload.sessionId).toBe('claude-session-secret');
  });

  it('未配置 HOOK_SECRET 时消息不含 secret 字段', async () => {
    const home = mkdtempSync(join(tmpdir(), 'workspacecord-hook-home-'));
    tempHomes.push(home);

    const messages: string[] = [];
    const server = createServer((socket) => {
      socket.on('data', (data) => {
        messages.push(data.toString().trim());
      });
      socket.on('end', () => socket.end());
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, () => resolve());
    });

    const child = spawn('node', [scriptPath, 'SessionStart'], {
      env: {
        ...process.env,
        HOME: home,
        workspacecord_HOOK_SOCKET: SOCKET_PATH,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(
      JSON.stringify({
        session_id: 'claude-session-nosecret',
        cwd: '/repo-nosecret',
      }),
    );
    child.stdin.end();

    await new Promise<{ code: number | null }>((resolve) => {
      child.on('close', (code) => resolve({ code }));
    });

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    expect(messages.length).toBe(1);

    const msg = JSON.parse(messages[0]) as {
      type: string;
      secret?: string;
      payload: { sessionId: string };
    };
    expect(msg.type).toBe('hook-event');
    expect(msg.secret).toBeUndefined();
    expect(msg.payload.sessionId).toBe('claude-session-nosecret');
  });
});
