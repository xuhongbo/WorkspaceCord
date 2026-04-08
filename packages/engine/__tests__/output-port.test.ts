import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionOutputPort } from '../src/output-port.ts';

describe('output-port', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadModule() {
    return await import('../src/output-port.ts');
  }

  it('getOutputPort throws when no port is registered', async () => {
    const { getOutputPort } = await loadModule();
    expect(() => getOutputPort()).toThrow(
      'OutputPort not registered. Call registerOutputPort() during bot startup.',
    );
  });

  it('registerOutputPort stores port and getOutputPort returns it', async () => {
    const { registerOutputPort, getOutputPort } = await loadModule();
    const mockPort = { fake: true } as unknown as SessionOutputPort;
    registerOutputPort(mockPort);
    expect(getOutputPort()).toBe(mockPort);
  });

  it('returns the most recently registered port', async () => {
    const { registerOutputPort, getOutputPort } = await loadModule();
    const port1 = { id: 1 } as unknown as SessionOutputPort;
    const port2 = { id: 2 } as unknown as SessionOutputPort;
    registerOutputPort(port1);
    registerOutputPort(port2);
    expect(getOutputPort()).toBe(port2);
  });
});
