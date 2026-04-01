import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveCodexSessionFromMonitor = vi.fn();
const normalizeCodexEvent = vi.fn();
const registerExistingStatusCard = vi.fn();
const updateSessionState = vi.fn();

vi.mock('../src/thread-manager.ts', () => ({
  resolveCodexSessionFromMonitor,
}));

vi.mock('../src/state/event-normalizer.ts', () => ({
  normalizeCodexEvent,
}));

vi.mock('../src/panel-adapter.ts', () => ({
  registerExistingStatusCard,
  updateSessionState,
}));

const { handleCodexMonitorStateChange } = await import('../src/codex-monitor-bridge.ts');

describe('codex-monitor-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('把监控事件映射到真实会话并刷新状态卡', async () => {
    resolveCodexSessionFromMonitor.mockReturnValue({
      id: 'session-1',
      channelId: 'channel-1',
      statusCardMessageId: 'msg-1',
    });
    normalizeCodexEvent.mockReturnValue({
      type: 'thinking_started',
      sessionId: 'session-1',
      source: 'codex',
      confidence: 'high',
      timestamp: 1,
    });

    const channel = { id: 'channel-1', send: vi.fn(), messages: {} };
    const handled = await handleCodexMonitorStateChange(
      (channelId) => (channelId === 'channel-1' ? channel : undefined),
      'codex:monitor-1',
      'thinking',
      'event_msg:task_started',
      { cwd: '/repo' },
    );

    expect(handled).toBe(true);
    expect(registerExistingStatusCard).toHaveBeenCalledWith('session-1', channel, 'msg-1');
    expect(updateSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'thinking_started' }),
      expect.objectContaining({ sourceHint: 'codex', channel }),
    );
  });

  it('找不到会话时返回 false', async () => {
    resolveCodexSessionFromMonitor.mockReturnValue(undefined);

    const handled = await handleCodexMonitorStateChange(
      () => undefined,
      'codex:monitor-2',
      'working',
      'response_item:function_call',
      { cwd: '/repo' },
    );

    expect(handled).toBe(false);
    expect(updateSessionState).not.toHaveBeenCalled();
  });
});
