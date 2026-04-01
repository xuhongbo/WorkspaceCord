#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const EVENT_QUEUE = '/tmp/workspacecord-hook-events.jsonl';
const HOOK_ENDPOINT = process.env.workspacecord_HOOK_URL || 'http://127.0.0.1:23456/hook-event';
const REQUEST_TIMEOUT_MS = 2000;
const FAILURE_LOG = path.join(os.homedir(), '.workspacecord', 'hook-failures.log');

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
  SubagentStop: 'work_started',
  PreCompact: 'compaction_started',
  PostCompact: 'completed',
  AskUser: 'awaiting_human',
};

const eventName = process.argv[2];
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

const platformEvent = {
  type: platformType,
  sessionId: input.session_id,
  source: 'claude',
  confidence: 'high',
  timestamp,
  metadata: {
    cwd: input.cwd || process.cwd(),
    hookEvent: eventName,
  },
};

const fallbackQueueEvent = {
  event: eventName,
  state: platformType,
  sessionId: input.session_id,
  metadata: {
    cwd: input.cwd || process.cwd(),
    timestamp,
    hookEvent: eventName,
  },
};

function appendFailureLog(errorMessage) {
  try {
    const dir = path.dirname(FAILURE_LOG);
    fs.mkdirSync(dir, { recursive: true });
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

function appendQueueFallback() {
  try {
    fs.appendFileSync(EVENT_QUEUE, JSON.stringify(fallbackQueueEvent) + '\n', 'utf8');
  } catch {
    // 静默失败，不影响 Claude Code 运行
  }
}

function postToHookServer(payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(HOOK_ENDPOINT);
    } catch {
      reject(new Error('INVALID_HOOK_ENDPOINT'));
      return;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`HOOK_HTTP_${res.statusCode || 0}`));
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('HOOK_TIMEOUT'));
    });

    req.on('error', (err) => reject(err));
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function main() {
  try {
    await postToHookServer(platformEvent);
  } catch (err) {
    appendFailureLog(err && err.message ? err.message : 'HOOK_POST_FAILED');
    appendQueueFallback();
  }
}

void main();
