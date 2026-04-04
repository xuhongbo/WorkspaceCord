#!/usr/bin/env node
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REQUEST_TIMEOUT_MS = 2000;
const HOME_DIR = os.homedir();
const WS_DIR = path.join(HOME_DIR, '.workspacecord');
const FAILURE_LOG = path.join(WS_DIR, 'hook-failures.log');
const QUEUE_FILE = path.join(WS_DIR, 'hook-queue.jsonl');
const MAX_RETRY = 3;
const DRAIN_BATCH = 10;
const DEFAULT_SOCKET_PATH = '/tmp/workspacecord.sock';

const EVENT_TO_STATE = {
  SessionStart: 'session_started',
  SessionEnd: 'session_ended',
  UserPromptSubmit: 'thinking_started',
  PreToolUse: 'work_started',
  PostToolUse: 'work_started',
  PostToolUseFailure: 'errored',
  Stop: 'completed',
  StopFailure: 'errored',
  SubagentStart: 'work_started',
  SubagentStop: 'completed',
  PreCompact: 'compaction_started',
  PostCompact: 'completed',
  AskUser: 'awaiting_human',
};

const eventName = process.argv[2];

function resolveWorkspacecordConfigPath() {
  if (process.env.WORKSPACECORD_CONFIG_PATH) {
    return process.env.WORKSPACECORD_CONFIG_PATH;
  }
  const baseDir = process.env.WORKSPACECORD_CONFIG_DIR
    ? process.env.WORKSPACECORD_CONFIG_DIR
    : path.join(HOME_DIR, '.config', 'workspacecord');
  return path.join(baseDir, 'config.json');
}

function resolveSocketPath() {
  if (process.env.workspacecord_HOOK_SOCKET) {
    return process.env.workspacecord_HOOK_SOCKET;
  }

  const configPath = resolveWorkspacecordConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      return DEFAULT_SOCKET_PATH;
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    return config.IPC_SOCKET_PATH || DEFAULT_SOCKET_PATH;
  } catch {
    return DEFAULT_SOCKET_PATH;
  }
}

// --drain 模式: 跳过 stdin 读取和事件解析,直接处理队列
if (eventName === '--drain') {
  drainQueue().catch(() => {});
  return;
}

let inputJson = process.argv[3];

if (!inputJson) {
  try {
    inputJson = fs.readFileSync(0, 'utf8').trim();
  } catch {
    inputJson = '';
  }
}

if (!eventName || !inputJson) {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(inputJson);
} catch {
  process.exit(0);
}

const timestamp = Date.now();
const platformType = EVENT_TO_STATE[eventName];
if (!platformType || !input.session_id) {
  process.exit(0);
}

const subagentMetadata =
  input.agent_id
    ? {
        parentProviderSessionId: input.session_id,
        agentId: input.agent_id,
        agentType: input.agent_type,
      }
    : undefined;

const platformEvent = {
  type: platformType,
  sessionId: input.session_id,
  source: 'claude',
  confidence: 'high',
  timestamp,
  metadata: {
    cwd: input.cwd || process.cwd(),
    hookEvent: eventName,
    ...(subagentMetadata ? { subagent: subagentMetadata } : {}),
  },
};

function ensureDir() {
  fs.mkdirSync(WS_DIR, { recursive: true });
}

function appendFailureLog(errorMessage) {
  try {
    ensureDir();
    fs.appendFileSync(
      FAILURE_LOG,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: eventName,
        session_id: input.session_id,
        cwd: input.cwd || process.cwd(),
        error: errorMessage,
        retry_count: 0,
      }) + '\n',
      'utf8',
    );
  } catch {
    // 静默失败，不影响 Claude Code 运行
  }
}

function writeToQueue(event) {
  try {
    ensureDir();
    fs.appendFileSync(QUEUE_FILE, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // 队列写入失败则降级到纯失败日志
    appendFailureLog('QUEUE_WRITE_FAILED');
  }
}

function spawnDrain() {
  try {
    const child = spawn(
      process.execPath,
      [__filename, '--drain'],
      { detached: true, stdio: 'ignore', env: { ...process.env } }
    );
    child.unref();
  } catch {
    // 衍生失败不影响主流程
  }
}

function postToSocket(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(resolveSocketPath(), () => {
      const message = { type: 'hook-event', payload };
      if (process.env.workspacecord_HOOK_SECRET) {
        message.secret = process.env.workspacecord_HOOK_SECRET;
      }
      socket.write(JSON.stringify(message) + '\n');
      socket.end();
    });
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('IPC_TIMEOUT'));
    });
    socket.on('error', (err) => reject(err));
    socket.on('end', resolve);
  });
}

async function drainQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return;
  let lines;
  try {
    lines = fs.readFileSync(QUEUE_FILE, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return;
  }
  if (lines.length === 0) return;

  const remaining = [];
  let sent = 0;
  for (const line of lines) {
    if (sent >= DRAIN_BATCH) {
      remaining.push(line);
      continue;
    }
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if ((entry.retry_count || 0) >= MAX_RETRY) continue;

    try {
      await postToSocket(entry);
      sent++;
    } catch {
      entry.retry_count = (entry.retry_count || 0) + 1;
      remaining.push(JSON.stringify(entry));
    }
  }

  if (remaining.length === 0) {
    try { fs.unlinkSync(QUEUE_FILE); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(QUEUE_FILE, remaining.join('\n') + '\n', 'utf8');
  }
}

async function main() {
  // 尝试发送当前事件
  let queued = false;
  try {
    await postToSocket(platformEvent);
  } catch (err) {
    // 入队以便后续重试
    const queueEntry = {
      ...platformEvent,
      retry_count: 0,
      queued_at: Date.now(),
    };
    writeToQueue(queueEntry);
    appendFailureLog(err && err.message ? err.message : 'IPC_POST_FAILED');
    queued = true;
  }

  // 如果当前事件入队了，衍生后台进程排空队列（非阻塞）
  if (queued) {
    spawnDrain();
  }
}

void main();
