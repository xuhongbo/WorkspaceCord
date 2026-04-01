import { resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

// Sanitize a string into a valid Discord thread / session name
export function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'session'
  );
}

// Resolve a path, expanding ~ to home directory
export function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', homedir());
  }
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// Check if a path is within allowed roots
export function isPathAllowed(path: string, allowedPaths: readonly string[]): boolean {
  if (allowedPaths.length === 0) return true;
  const resolved = resolvePath(path);
  return allowedPaths.some((allowed) => {
    const resolvedAllowed = resolvePath(allowed);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + '/');
  });
}

// Derive project name from channel name (Discord channel names are already sanitized)
export function projectNameFromChannel(channelName: string): string {
  return channelName;
}

// Format a duration in ms as human-readable
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Format a timestamp as relative time
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Truncate a string to a max length with ellipsis
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Check if a user is in the allowed list
export function isUserAllowed(
  userId: string,
  allowedUsers: readonly string[],
  allowAll: boolean,
): boolean {
  if (allowAll) return true;
  if (allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId);
}

const ABORT_PATTERNS = ['abort', 'cancel', 'interrupt', 'killed', 'signal'];

// Check if an error is an AbortError
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = ((err as Error).message || '').toLowerCase();
  return ABORT_PATTERNS.some((p) => msg.includes(p));
}

export function isAbortErrorMessage(messages: string[]): boolean {
  return messages.some((m) => ABORT_PATTERNS.some((p) => m.toLowerCase().includes(p)));
}

export function detectNumberedOptions(text: string): string[] | null {
  const lines = text.trim().split('\n');
  const options: string[] = [];
  const optionRegex = /^\s*(\d+)[.)]\s+(.+)$/;
  let firstOptionLine = -1;
  let lastOptionLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(optionRegex);
    if (match) {
      if (firstOptionLine === -1) firstOptionLine = i;
      lastOptionLine = i;
      options.push(match[2].trim());
    }
  }

  if (options.length < 2 || options.length > 6) return null;
  if (options.some((o) => o.length > 80)) return null;

  const linesAfter = lines.slice(lastOptionLine + 1).filter((l) => l.trim()).length;
  if (linesAfter > 3) return null;

  const preamble = lines.slice(0, firstOptionLine).join(' ').toLowerCase();
  const hasQuestion =
    /\?\s*$/.test(preamble.trim()) ||
    /\b(which|choose|select|pick|prefer|would you like|how would you|what approach|option)\b/.test(
      preamble,
    );

  return hasQuestion ? options : null;
}

export function detectYesNoPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(y\/n|yes\/no|confirm|proceed)\b/.test(lower) ||
    (/\?\s*$/.test(text.trim()) && /\b(should|would you|do you want|shall)\b/.test(lower))
  );
}

export function formatUptime(startTime: number): string {
  const ms = Date.now() - startTime;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// Split a long string into Discord-safe chunks (max 2000 chars)
export function splitMessage(text: string, max = 1900): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + max));
    i += max;
  }
  return chunks;
}

// Format cost in USD
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
