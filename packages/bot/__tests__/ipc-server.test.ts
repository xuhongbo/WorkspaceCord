import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';

// Mutable config -- vi.mock below captures a reference to this object
const testConfig = {
  hookSecret: '',
  socketPath: '/tmp/workspacecord.sock',
};

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    get config() { return testConfig; },
  };
});

const mockClient = {
  channels: { cache: new Map() },
  on: vi.fn(),
} as unknown as Parameters<typeof import('../src/ipc-server.ts')['startIpcServer']>[0];

/**
 * Stop any existing IPC server and start a fresh one.
 * The mock config's hookSecret should be set before calling this.
 */
async function restartServer(): Promise<{ socketPath: string; stopIpcServer: () => void }> {
  const { startIpcServer, stopIpcServer } = await import('../src/ipc-server.ts');
  stopIpcServer();

  const socketPath = testConfig.socketPath;
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  startIpcServer(mockClient);
  await new Promise((r) => setImmediate(r));
  return { socketPath, stopIpcServer };
}

function sendIpcMessage(socketPath: string, msg: object): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('IPC_TIMEOUT')), 3000);
    const conn = createConnection(socketPath, () => {
      conn.write(JSON.stringify(msg) + '\n');
      conn.end();
    });
    conn.on('close', () => { clearTimeout(timeout); resolve(); });
    conn.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

describe('IPC server authentication', () => {
  beforeEach(() => {
    testConfig.hookSecret = '';
    testConfig.socketPath = '/tmp/workspacecord.sock';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Stop the IPC server and clean up the socket
    try {
      const { stopIpcServer } = await import('../src/ipc-server.ts');
      stopIpcServer();
    } catch { /* module may not be loaded */ }
    const socketPath = testConfig.socketPath;
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
  });

  it('listens on the configured socket path', async () => {
    testConfig.socketPath = '/tmp/workspacecord-custom.sock';
    const { socketPath } = await restartServer();

    expect(socketPath).toBe('/tmp/workspacecord-custom.sock');
    expect(existsSync(socketPath)).toBe(true);
  });

  it('rejects messages with wrong secret', async () => {
    testConfig.hookSecret = 'test-secret';
    const { socketPath } = await restartServer();

    await sendIpcMessage(socketPath, {
      type: 'hook-event',
      payload: { sessionId: 's1', type: 'session_started', source: 'claude' },
      secret: 'wrong-secret',
    });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rejected unauthenticated message'),
    );
  });

  it('rejects messages without secret when hookSecret is configured', async () => {
    testConfig.hookSecret = 'test-secret';
    const { socketPath } = await restartServer();

    await sendIpcMessage(socketPath, {
      type: 'hook-event',
      payload: { sessionId: 's1', type: 'session_started', source: 'claude' },
    });

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Rejected unauthenticated message'),
    );
  });

  it('accepts messages with correct secret', async () => {
    testConfig.hookSecret = 'test-secret';
    const { socketPath } = await restartServer();

    await sendIpcMessage(socketPath, {
      type: 'hook-event',
      payload: { sessionId: 's1', type: 'session_started', source: 'claude' },
      secret: 'test-secret',
    });

    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Rejected unauthenticated message'),
    );
  });

  it('accepts messages without secret when hookSecret is empty (backwards compatible)', async () => {
    testConfig.hookSecret = '';
    const { socketPath } = await restartServer();

    await sendIpcMessage(socketPath, {
      type: 'hook-event',
      payload: { sessionId: 's1', type: 'session_started', source: 'claude' },
    });

    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Rejected unauthenticated message'),
    );
  });
});

describe('IPC server shutdown and resource cleanup', () => {
  beforeEach(() => {
    testConfig.hookSecret = '';
    testConfig.socketPath = '/tmp/workspacecord-cleanup.sock';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      const { stopIpcServer } = await import('../src/ipc-server.ts');
      stopIpcServer();
    } catch { /* module may not be loaded */ }
    const socketPath = testConfig.socketPath;
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
  });

  it('removes the socket file on stopIpcServer', async () => {
    const { socketPath, stopIpcServer } = await restartServer();
    expect(existsSync(socketPath)).toBe(true);

    stopIpcServer();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('destroys active sockets when stopIpcServer is called', async () => {
    const { socketPath, stopIpcServer } = await restartServer();

    // Open a long-lived connection (don't send end())
    const conn = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      conn.once('connect', () => resolve());
      conn.once('error', reject);
    });

    // Stop the server — should destroy the active socket server-side
    stopIpcServer();

    // Wait until our client sees the disconnect
    await new Promise<void>((resolve) => {
      if (conn.destroyed) return resolve();
      conn.once('close', () => resolve());
      conn.once('error', () => resolve());
      // Safety timeout
      setTimeout(() => resolve(), 500);
    });

    expect(conn.destroyed).toBe(true);
    conn.destroy();
  });

  it('stopIpcServer is idempotent and safe to call twice', async () => {
    const { stopIpcServer } = await restartServer();
    stopIpcServer();
    expect(() => stopIpcServer()).not.toThrow();
  });

  it('allows restarting after stopIpcServer (no port conflict)', async () => {
    const first = await restartServer();
    first.stopIpcServer();
    expect(existsSync(first.socketPath)).toBe(false);

    // Restart — should succeed without error
    const second = await restartServer();
    expect(existsSync(second.socketPath)).toBe(true);
    second.stopIpcServer();
  });
});
