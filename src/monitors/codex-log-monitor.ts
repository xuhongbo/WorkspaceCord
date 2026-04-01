// Codex 日志监控器：增量读取 JSONL 日志 + 快速发现新会话
// 直接移植自 clawd-on-desk/agents/codex-log-monitor.js
// 阶段二升级：首事件快速发现成为主路径（设计文档 7.3 节）

import { readFileSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const APPROVAL_HEURISTIC_MS = 2000;
const POLL_INTERVAL_ACTIVE_MS = 500; // 活跃会话轮询间隔
const POLL_INTERVAL_IDLE_MS = 2000; // 空闲会话轮询间隔
const STALE_CLEANUP_MS = 300000; // 5 分钟无活动后清理
const MAX_LINES_PER_POLL = 100; // 单次轮询最多读取行数
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB 缓冲区限制

interface TrackedFile {
  offset: number;
  sessionId: string;
  cwd: string;
  lastEventTime: number;
  lastState: string | null;
  partial: string;
  hadToolUse: boolean;
  approvalTimer?: NodeJS.Timeout;
  registered: boolean; // 是否已触发注册
  pollInterval: number; // 当前轮询间隔
  remoteHumanControl?: boolean; // 是否为受管会话
  bufferSize: number; // 当前缓冲区大小
}

type StateChangeCallback = (
  sessionId: string,
  state: string,
  event: string,
  extra: { cwd: string; permissionDetail?: { command: string } },
) => void;

type RegistrationCallback = (
  providerSessionId: string,
  cwd: string,
  remoteHumanControl?: boolean,
) => Promise<boolean>;

export class CodexLogMonitor {
  private tracked = new Map<string, TrackedFile>();
  private interval: NodeJS.Timeout | null = null;
  private baseDir: string;
  private onStateChange: StateChangeCallback;
  private onRegisterSession?: RegistrationCallback;

  constructor(
    baseDir: string,
    onStateChange: StateChangeCallback,
    onRegisterSession?: RegistrationCallback,
  ) {
    this.baseDir = baseDir.startsWith('~')
      ? join(homedir(), baseDir.slice(1))
      : baseDir;
    this.onStateChange = onStateChange;
    this.onRegisterSession = onRegisterSession;
  }

  start(): void {
    if (this.interval) return;
    this.poll();
    // 使用活跃间隔启动，后续根据活动情况动态调整
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_ACTIVE_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const tracked of this.tracked.values()) {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
    }
    this.tracked.clear();
  }

  private poll(): void {
    const dirs = this.getSessionDirs();
    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const filePath = join(dir, file);
        if (!this.tracked.has(filePath)) {
          try {
            const mtime = statSync(filePath).mtimeMs;
            if (now - mtime > 120000) continue;
          } catch {
            continue;
          }
        }
        this.pollFile(filePath, file);
      }
    }
    this.cleanStaleFiles();
  }

  private getSessionDirs(): string[] {
    const dirs: string[] = [];
    const now = new Date();
    for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      dirs.push(join(this.baseDir, String(yyyy), mm, dd));
    }
    return dirs;
  }

  private pollFile(filePath: string, fileName: string): void {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return;
    }

    let tracked = this.tracked.get(filePath);
    if (!tracked) {
      const sessionId = this.extractSessionId(fileName);
      if (!sessionId) return;
      tracked = {
        offset: 0,
        sessionId: 'codex:' + sessionId,
        cwd: '',
        lastEventTime: Date.now(),
        lastState: null,
        partial: '',
        hadToolUse: false,
        registered: false,
        pollInterval: POLL_INTERVAL_ACTIVE_MS,
        bufferSize: 0,
      };
      this.tracked.set(filePath, tracked);
    }

    if (stat.size <= tracked.offset) return;

    // 缓冲区限制：如果 partial 缓冲区超过 10MB，强制刷新
    if (tracked.partial.length > MAX_BUFFER_SIZE) {
      console.warn(
        `[CodexLogMonitor] Buffer overflow for ${tracked.sessionId}, flushing ${tracked.partial.length} bytes`,
      );
      tracked.partial = '';
      tracked.bufferSize = 0;
    }

    let buf: Buffer;
    try {
      const fd = openSync(filePath, 'r');
      const readLen = Math.min(stat.size - tracked.offset, MAX_LINES_PER_POLL * 1024);
      buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, tracked.offset);
      closeSync(fd);
    } catch {
      return;
    }
    tracked.offset += buf.length;
    tracked.bufferSize += buf.length;

    const text = tracked.partial + buf.toString('utf8');
    const lines = text.split('\n');
    tracked.partial = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      this.processLine(line, tracked);
    }

    // 重置缓冲区大小计数
    tracked.bufferSize = tracked.partial.length;

    // 动态调整轮询间隔
    const timeSinceLastEvent = Date.now() - tracked.lastEventTime;
    if (timeSinceLastEvent < 10000) {
      tracked.pollInterval = POLL_INTERVAL_ACTIVE_MS;
    } else if (timeSinceLastEvent < 60000) {
      tracked.pollInterval = POLL_INTERVAL_IDLE_MS;
    }
  }

  private extractSessionId(fileName: string): string | null {
    const base = fileName.replace('.jsonl', '');
    const parts = base.split('-');
    if (parts.length < 10) return null;
    return parts.slice(-5).join('-');
  }

  private processLine(line: string, tracked: TrackedFile): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    const type = typeof obj.type === 'string' ? obj.type : '';
    const payload =
      obj.payload && typeof obj.payload === 'object'
        ? (obj.payload as Record<string, unknown>)
        : undefined;
    const subtype = typeof payload?.type === 'string' ? payload.type : '';
    const key = subtype ? `${type}:${subtype}` : type;

    // 提取 cwd（设计文档 7.3 节第 2 步）
    if (type === 'session_meta' && payload) {
      tracked.cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

      // 检测受管会话标记（阶段五：设计文档 9.4 节）
      // 受管会话通过 workspacecord codex 启动，会设置 workspacecord_MANAGED 环境变量
      if (payload.env && typeof payload.env === 'object') {
        const env = payload.env as Record<string, unknown>;
        tracked.remoteHumanControl = env.workspacecord_MANAGED === '1';
      }
    }

    // 快速注册：读到首个有效事件时，如果会话未注册且有 cwd，触发注册
    if (!tracked.registered && tracked.cwd && this.onRegisterSession) {
      const state = this.mapEventToState(key);
      if (state !== undefined && state !== null) {
        tracked.registered = true;
        const providerSessionId = tracked.sessionId.replace(/^codex:/, '');
        const registerPromise =
          tracked.remoteHumanControl === undefined
            ? this.onRegisterSession(providerSessionId, tracked.cwd)
            : this.onRegisterSession(
                providerSessionId,
                tracked.cwd,
                tracked.remoteHumanControl,
              );
        void registerPromise.then((success) => {
          if (success) {
            console.log(
              `[CodexLogMonitor] Fast registration triggered for session ${providerSessionId}`,
            );
          }
        });
      }
    }

    if (key === 'event_msg:exec_command_end' || key === 'response_item:function_call_output') {
      if (tracked.approvalTimer) {
        clearTimeout(tracked.approvalTimer);
        tracked.approvalTimer = undefined;
      }
    }

    const state = this.mapEventToState(key);
    if (state === undefined) return;
    if (state === null) return;

    if (key === 'event_msg:task_started') tracked.hadToolUse = false;
    if (key === 'response_item:function_call') tracked.hadToolUse = true;

    if (state === 'codex-turn-end') {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const resolved = tracked.hadToolUse ? 'attention' : 'idle';
      tracked.hadToolUse = false;
      tracked.lastState = resolved;
      tracked.lastEventTime = Date.now();
      this.onStateChange(tracked.sessionId, resolved, key, { cwd: tracked.cwd });
      return;
    }

    if (key === 'response_item:function_call') {
      if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
      const cmd = this.extractShellCommand(payload);
      if (cmd) {
        tracked.approvalTimer = setTimeout(() => {
          tracked.approvalTimer = undefined;
          tracked.lastEventTime = Date.now();
          this.onStateChange(tracked.sessionId, 'codex-permission', key, {
            cwd: tracked.cwd,
            permissionDetail: { command: cmd },
          });
        }, APPROVAL_HEURISTIC_MS);
      }
    }

    if (state === tracked.lastState && state === 'working') return;
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();
    this.onStateChange(tracked.sessionId, state, key, { cwd: tracked.cwd });
  }

  private mapEventToState(key: string): string | null | undefined {
    const map: Record<string, string | null> = {
      'session_meta': 'idle',
      'event_msg:task_started': 'thinking',
      'event_msg:user_message': 'thinking',
      'event_msg:agent_message': null,
      'response_item:function_call': 'working',
      'response_item:custom_tool_call': 'working',
      'response_item:web_search_call': 'working',
      'event_msg:exec_command_start': 'working',
      'event_msg:task_complete': 'codex-turn-end',
      'event_msg:context_compacted': 'sweeping',
      'event_msg:turn_aborted': 'idle',
      'event_msg:error': 'error',
    };
    return map[key];
  }

  private extractShellCommand(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    if (!('name' in payload) || payload.name !== 'shell_command') return '';
    try {
      const rawArgs =
        'arguments' in payload
          ? payload.arguments
          : undefined;
      const args =
        typeof rawArgs === 'string'
          ? (JSON.parse(rawArgs) as Record<string, unknown>)
          : rawArgs;
      if (args && typeof args === 'object' && 'command' in args && args.command) {
        return String(args.command);
      }
    } catch {
      return '';
    }
    return '';
  }

  private cleanStaleFiles(): void {
    const now = Date.now();
    for (const [filePath, tracked] of this.tracked) {
      const age = now - tracked.lastEventTime;
      if (age > STALE_CLEANUP_MS) {
        if (tracked.approvalTimer) clearTimeout(tracked.approvalTimer);
        this.onStateChange(tracked.sessionId, 'sleeping', 'stale-cleanup', { cwd: tracked.cwd });
        this.tracked.delete(filePath);
      }
    }
  }
}
