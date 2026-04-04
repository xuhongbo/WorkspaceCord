import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnection } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';

// Mutable config -- vi.mock below captures a reference to this object
const testConfig = { hookSecret: '' };

vi.mock('../src/config.ts', () => ({
  get config() { return testConfig; },
}));

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

  const socketPath = '/tmp/workspacecord.sock';
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
    const socketPath = '/tmp/workspacecord.sock';
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* ignore */ }
    }
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
