import { beforeEach, describe, expect, it, vi } from 'vitest';

const execa = vi.fn();
const initializeSessionPanel = vi.fn();
const updateSessionState = vi.fn();
const queueDigest = vi.fn();
const flushDigest = vi.fn();
const handleResultEvent = vi.fn();

vi.mock('execa', () => ({ execa }));
vi.mock('../src/panel-adapter.ts', () => ({
  initializeSessionPanel,
  updateSessionState,
  queueDigest,
  flushDigest,
  handleResultEvent,
}));

const { executeShellCommand } = await import('../src/shell-handler.ts');

describe('shell-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execa.mockReturnValue({
      all: 'done',
      exitCode: 0,
      timedOut: false,
      kill: vi.fn(),
      then: undefined,
    });
  });

  it('通过面板适配层展示 shell 执行状态与结束总结', async () => {
    const child = Promise.resolve({ all: 'X'.repeat(5000), exitCode: 0, timedOut: false });
    child.kill = vi.fn();
    execa.mockReturnValue(child);
    const channel = { send: vi.fn() };

    await executeShellCommand('pwd', '/repo', channel as never);

    expect(initializeSessionPanel).toHaveBeenCalled();
    expect(updateSessionState).toHaveBeenCalled();
    expect(queueDigest).toHaveBeenCalled();
    expect(flushDigest).toHaveBeenCalled();
    expect(handleResultEvent).toHaveBeenCalled();
    const call = handleResultEvent.mock.calls.at(-1);
    expect(String(call?.[2]).includes('X'.repeat(200))).toBe(true);
    expect(channel.send).not.toHaveBeenCalled();
  });
});
