import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const resolveCodexSessionFromMonitor = vi.fn();
const normalizeCodexEvent = vi.fn();
const registerExistingStatusCard = vi.fn();
const updateSessionState = vi.fn();

vi.mock('@workspacecord/engine/session-registry', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()),
  resolveCodexSessionFromMonitor,
}));

vi.mock('@workspacecord/state/event-normalizer', () => ({
  normalizeCodexEvent,
}));

vi.mock('../../src/panel-adapter.ts', () => ({
  registerExistingStatusCard,
  updateSessionState,
}));

const { CodexLogMonitor } = await import('../../src/monitors/codex-log-monitor.ts');
const { handleCodexMonitorStateChange } = await import('../../src/codex-monitor-bridge.ts');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSessionDir(baseDir: string): { dir: string; filePath: string; fileName: string } {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dir = join(baseDir, yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  const fileName = 'rollout-2026-04-04-a-b-c-d-e-f.jsonl';
  const filePath = join(dir, fileName);
  writeFileSync(filePath, '', 'utf8');
  return { dir, filePath, fileName };
}

function makeMockChannel() {
  const messagesMap = new Map();
  return {
    id: 'channel-mon-1',
    name: 'codex-session',
    send: vi.fn(async () => ({ id: 'msg-status', edit: vi.fn() })),
    messages: {
      fetch: vi.fn(async (id: string) => messagesMap.get(id) ?? null),
    },
    _updateEmbed: vi.fn((title: string) => {
      messagesMap.set('msg-status', {
        id: 'msg-status',
        embeds: [{ data: { title, description: 'Monitor state' } }],
      });
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('codex-monitor integration: JSONL-driven state transitions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-04T10:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('CodexLogMonitor reads rollout JSONL and drives status card updates via bridge', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-int-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    // Write session_meta + event_msg
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/integration/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );

    // Manually poll (simulating monitor cycle)
    (monitor as any).pollFile(filePath, fileName);

    expect(onStateChange).toHaveBeenCalledTimes(2);

    // First: session_meta → idle
    expect(onStateChange).toHaveBeenNthCalledWith(
      1,
      'codex:b-c-d-e-f',
      'idle',
      'session_meta',
      { cwd: '/integration/repo' },
    );

    // Second: task_started → thinking
    expect(onStateChange).toHaveBeenNthCalledWith(
      2,
      'codex:b-c-d-e-f',
      'thinking',
      'event_msg:task_started',
      { cwd: '/integration/repo' },
    );

    // Now bridge the state change to a status card
    resolveCodexSessionFromMonitor.mockReturnValue({
      id: 'session-int-1',
      channelId: 'channel-mon-1',
      statusCardMessageId: 'msg-status',
    });
    normalizeCodexEvent.mockReturnValue({
      type: 'thinking_started',
      sessionId: 'session-int-1',
      source: 'codex',
      confidence: 'high',
      timestamp: 1,
    });

    const channel = makeMockChannel();
    const handled = await handleCodexMonitorStateChange(
      (channelId: string) => (channelId === 'channel-mon-1' ? channel : undefined),
      'codex:b-c-d-e-f',
      'thinking',
      'event_msg:task_started',
      { cwd: '/integration/repo' },
    );

    expect(handled).toBe(true);
    expect(updateSessionState).toHaveBeenCalledWith(
      'session-int-1',
      expect.objectContaining({ type: 'thinking_started' }),
      expect.objectContaining({ sourceHint: 'codex', channel }),
    );
  });

  it('state transitions: session_meta → event_msg:task_started → response_item:function_call → event_msg:task_complete', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-state-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    // Write the full state transition sequence
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/state/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'ls' }) },
      })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
      'utf8',
    );

    (monitor as any).pollFile(filePath, fileName);

    // Verify state progression
    const calls = onStateChange.mock.calls;
    const states = calls.map((c: string[]) => c[1]);

    // session_meta → idle
    expect(states[0]).toBe('idle');
    // task_started → thinking
    expect(states[1]).toBe('thinking');
    // function_call → working
    expect(states[2]).toBe('working');

    // task_complete with tool use → attention
    expect(states[3]).toBe('attention');
  });

  it('monitor drives full thinking → executing → completed lifecycle via bridge', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-lifecycle-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    const channel = makeMockChannel();
    const stateToDisplay: Record<string, string> = {
      thinking: '正在思考',
      working: '正在执行',
      attention: '需要关注',
      idle: '空闲',
      completed: '已完成',
    };

    resolveCodexSessionFromMonitor.mockReturnValue({
      id: 'session-lifecycle-1',
      channelId: 'channel-mon-1',
      statusCardMessageId: 'msg-status',
    });

    // Bridge callback that tracks display states
    const displayStates: string[] = [];
    normalizeCodexEvent.mockImplementation((eventKey: string) => ({
      type: eventKey.replace(':', '_'),
      sessionId: 'session-lifecycle-1',
      source: 'codex',
      confidence: 'high',
      timestamp: Date.now(),
    }));
    updateSessionState.mockImplementation(async () => {
      // Simulate status card update
      const lastState = onStateChange.mock.calls[onStateChange.mock.calls.length - 1]?.[1];
      if (lastState && stateToDisplay[lastState]) {
        displayStates.push(stateToDisplay[lastState]);
      }
    });

    // Step 1: session_meta + task_started → thinking
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/lifecycle/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    // Bridge the thinking state
    await handleCodexMonitorStateChange(
      (cid: string) => (cid === 'channel-mon-1' ? channel : undefined),
      'codex:a-b-c-d-e-f',
      'thinking',
      'event_msg:task_started',
      { cwd: '/lifecycle/repo' },
    );

    // Step 2: function_call → working
    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'npm test' }) },
      })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    // Bridge the working state
    await handleCodexMonitorStateChange(
      (cid: string) => (cid === 'channel-mon-1' ? channel : undefined),
      'codex:a-b-c-d-e-f',
      'working',
      'response_item:function_call',
      { cwd: '/lifecycle/repo' },
    );

    // Step 3: Advance timer to trigger codex-permission state
    vi.advanceTimersByTime(2000);

    // Step 4: task_complete → attention (because tool was used)
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    // Bridge the completed state
    await handleCodexMonitorStateChange(
      (cid: string) => (cid === 'channel-mon-1' ? channel : undefined),
      'codex:a-b-c-d-e-f',
      'attention',
      'event_msg:task_complete',
      { cwd: '/lifecycle/repo' },
    );

    // Verify the state progression went through the key states
    const allStates = onStateChange.mock.calls.map((c: string[]) => c[1]);
    expect(allStates).toContain('thinking');
    expect(allStates).toContain('working');
    expect(allStates).toContain('attention');

    // Verify bridge was called for each state transition
    expect(updateSessionState).toHaveBeenCalledTimes(3);
  });
});
