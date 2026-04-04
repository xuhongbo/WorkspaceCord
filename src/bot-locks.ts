import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

const LOCK_FILE = join(config.dataDir, 'bot.lock');
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface LockData {
  pid: number;
  startedAt: number;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getLockInfo(): { pid: number; startedAt: number; age: number } | null {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8').trim();
    const data: LockData = JSON.parse(raw);
    return { pid: data.pid, startedAt: data.startedAt, age: Date.now() - data.startedAt };
  } catch {
    return null;
  }
}

export function acquireLock(): boolean {
  if (!existsSync(LOCK_FILE)) {
    const data: LockData = { pid: process.pid, startedAt: Date.now() };
    writeFileSync(LOCK_FILE, JSON.stringify(data), 'utf-8');
    return true;
  }

  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8').trim();
    const data: LockData = JSON.parse(raw);

    const processAlive = isProcessRunning(data.pid);
    const stale = Date.now() - data.startedAt > STALE_THRESHOLD_MS;

    if (processAlive) {
      // Process still running — NEVER stale, always block
      console.error(`[lock] Another instance is already running (PID ${data.pid}, age ${Math.round((Date.now() - data.startedAt) / 1000)}s). Exiting.`);
      return false;
    }

    if (stale) {
      console.error(`[lock] Removing stale lock (PID ${data.pid}, age ${Math.round((Date.now() - data.startedAt) / 1000)}s)`);
    }
    // Dead process — safe to remove the orphaned lock
    unlinkSync(LOCK_FILE);
  } catch {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }

  const data: LockData = { pid: process.pid, startedAt: Date.now() };
  writeFileSync(LOCK_FILE, JSON.stringify(data), 'utf-8');
  return true;
}

export function releaseLock(): void {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const raw = readFileSync(LOCK_FILE, 'utf-8').trim();
    const data: LockData = JSON.parse(raw);
    if (data.pid === process.pid) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

export function isLocked(): boolean {
  const info = getLockInfo();
  if (!info) return false;
  if (isProcessRunning(info.pid)) return true;
  // Stale lock — clean it up
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
  return false;
}
