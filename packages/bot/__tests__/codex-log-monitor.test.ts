import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CodexLogMonitor } from '../src/monitors/codex-log-monitor.ts';

function makeSessionDir(baseDir: string): { dir: string; filePath: string; fileName: string } {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dir = join(baseDir, yyyy, mm, dd);
  mkdirSync(dir, { recursive: true });
  const fileName = 'rollout-a-b-c-d-e-f-g-h-i-j.jsonl';
  const filePath = join(dir, fileName);
  writeFileSync(filePath, '', 'utf8');
  return { dir, filePath, fileName };
}

describe('CodexLogMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('按 offset 增量读取新行而不重复旧事件', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);
    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith(
      'codex:f-g-h-i-j',
      'idle',
      'session_meta',
      { cwd: '/repo' },
    );

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    expect(onStateChange).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenLastCalledWith(
      'codex:f-g-h-i-j',
      'thinking',
      'event_msg:task_started',
      { cwd: '/repo' },
    );
  });

  it('会缓存 partial 行并在补全后处理', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    appendFileSync(filePath, '{"type":"session_meta","payload":{"cwd":"/repo"}}', 'utf8');
    (monitor as any).pollFile(filePath, fileName);
    expect(onStateChange).not.toHaveBeenCalled();

    appendFileSync(filePath, '\n', 'utf8');
    (monitor as any).pollFile(filePath, fileName);

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith(
      'codex:f-g-h-i-j',
      'idle',
      'session_meta',
      { cwd: '/repo' },
    );
  });

  it('对 shell_command function_call 在超时后推断 codex-permission', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({ command: 'npm test' }),
        },
      })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    expect(onStateChange).toHaveBeenNthCalledWith(
      2,
      'codex:f-g-h-i-j',
      'working',
      'response_item:function_call',
      { cwd: '/repo' },
    );

    vi.advanceTimersByTime(2000);

    expect(onStateChange).toHaveBeenLastCalledWith(
      'codex:f-g-h-i-j',
      'codex-permission',
      'response_item:function_call',
      { cwd: '/repo', permissionDetail: { command: 'npm test' } },
    );
  });

  it('task_complete 在有工具使用时落到 attention，无工具时落到 idle', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } })}\n`,
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
        payload: { type: 'function_call', name: 'shell_command', arguments: '{}' },
      })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    expect(onStateChange).toHaveBeenLastCalledWith(
      'codex:f-g-h-i-j',
      'attention',
      'event_msg:task_complete',
      { cwd: '/repo' },
    );

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
      'utf8',
    );
    (monitor as any).pollFile(filePath, fileName);

    expect(onStateChange).toHaveBeenLastCalledWith(
      'codex:f-g-h-i-j',
      'idle',
      'event_msg:task_complete',
      { cwd: '/repo' },
    );
  });

  it('会清理失活文件并发出 stale-cleanup', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const onStateChange = vi.fn();
    const monitor = new CodexLogMonitor(baseDir, onStateChange);

    (monitor as any).tracked.set('/tmp/stale.jsonl', {
      offset: 0,
      sessionId: 'codex:stale-session',
      cwd: '/repo',
      lastEventTime: Date.now() - 300001,
      lastState: 'working',
      partial: '',
      hadToolUse: false,
      registered: false,
      pollInterval: 500,
    });

    (monitor as any).cleanStaleFiles();

    expect(onStateChange).toHaveBeenCalledWith(
      'codex:stale-session',
      'sleeping',
      'stale-cleanup',
      { cwd: '/repo' },
    );
    expect((monitor as any).tracked.size).toBe(0);
  });

  it('在读到首个有效事件时触发快速注册', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const onRegisterSession = vi.fn().mockResolvedValue(true);
    const monitor = new CodexLogMonitor(baseDir, onStateChange, onRegisterSession);

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/test/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );

    (monitor as any).pollFile(filePath, fileName);

    expect(onRegisterSession).toHaveBeenCalledTimes(1);
    expect(onRegisterSession).toHaveBeenCalledWith('f-g-h-i-j', '/test/repo', undefined, undefined);
    expect(onStateChange).toHaveBeenCalledWith(
      'codex:f-g-h-i-j',
      'idle',
      'session_meta',
      { cwd: '/test/repo' },
    );
  });

  it('快速注册会携带子代理元数据', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const onRegisterSession = vi.fn().mockResolvedValue(true);
    const monitor = new CodexLogMonitor(baseDir, onStateChange, onRegisterSession);

    appendFileSync(
      filePath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          cwd: '/test/repo',
          forked_from_id: 'parent-session',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'parent-session',
                depth: 2,
              },
            },
          },
        },
      })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );

    (monitor as any).pollFile(filePath, fileName);

    expect(onRegisterSession).toHaveBeenCalledWith(
      'f-g-h-i-j',
      '/test/repo',
      undefined,
      { parentProviderSessionId: 'parent-session', depth: 2 },
    );
  });

  it('快速注册只触发一次，不会重复注册', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const onRegisterSession = vi.fn().mockResolvedValue(true);
    const monitor = new CodexLogMonitor(baseDir, onStateChange, onRegisterSession);

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/test/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } })}\n`,
      'utf8',
    );

    (monitor as any).pollFile(filePath, fileName);

    expect(onRegisterSession).toHaveBeenCalledTimes(1);
  });

  it('快速注册失败后会在后续事件重试', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'codex-monitor-'));
    const { filePath, fileName } = makeSessionDir(baseDir);
    const onStateChange = vi.fn();
    const onRegisterSession = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const monitor = new CodexLogMonitor(baseDir, onStateChange, onRegisterSession);

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/test/repo' } })}\n`,
      'utf8',
    );
    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
      'utf8',
    );

    (monitor as any).pollFile(filePath, fileName);
    await Promise.resolve();

    appendFileSync(
      filePath,
      `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call' } })}\n`,
      'utf8',
    );

    (monitor as any).pollFile(filePath, fileName);
    await Promise.resolve();

    expect(onRegisterSession).toHaveBeenCalledTimes(2);
  });
});
