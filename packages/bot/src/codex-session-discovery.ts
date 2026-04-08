import { existsSync, createReadStream } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let rgAvailable: boolean | null = null;

async function isRipgrepAvailable(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileAsync('rg', ['--version']);
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

export interface CodexIndexedSession {
  id: string;
  threadName: string;
  updatedAt?: number;
}

export interface CodexDiscoveredSession {
  id: string;
  threadName: string;
  updatedAt?: number;
  cwd: string;
  projectPath: string;
}

interface SessionMetaRecord {
  sessionId: string | null;
  cwd: string | null;
}

function parseUpdatedAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export async function readSessionIndex(codexHome = join(homedir(), '.codex')): Promise<CodexIndexedSession[]> {
  const indexPath = join(codexHome, 'session_index.jsonl');
  if (!existsSync(indexPath)) return [];

  let content: string;
  try {
    content = await readFile(indexPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter(Boolean);
  const out: CodexIndexedSession[] = [];
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (!json.id || typeof json.id !== 'string') continue;
      out.push({
        id: json.id,
        threadName:
          typeof json.thread_name === 'string' && json.thread_name ? json.thread_name : json.id,
        updatedAt: parseUpdatedAt(json.updated_at),
      });
    } catch {
      // skip malformed records
    }
  }
  return out;
}

async function readFirstLine(file: string): Promise<string | null> {
  try {
    const fh = await open(file, 'r');
    try {
      // Read in 8KB chunks until we find a newline or hit EOF (max 256KB)
      const CHUNK = 8192;
      const MAX = 256 * 1024;
      let accumulated = '';
      let offset = 0;
      while (offset < MAX) {
        const buf = Buffer.alloc(CHUNK);
        const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
        if (bytesRead === 0) break;
        const text = buf.toString('utf-8', 0, bytesRead);
        const newline = text.indexOf('\n');
        if (newline >= 0) {
          return accumulated + text.slice(0, newline);
        }
        accumulated += text;
        offset += bytesRead;
      }
      return accumulated || null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function readSessionMetaRecord(file: string): Promise<SessionMetaRecord | null> {
  try {
    const firstLine = await readFirstLine(file);
    if (!firstLine) return null;
    const first = JSON.parse(firstLine);
    if (first.type !== 'session_meta') return null;
    const sessionId =
      typeof first.payload?.id === 'string'
        ? first.payload.id
        : typeof first.id === 'string'
          ? first.id
          : null;
    const cwd = typeof first.payload?.cwd === 'string' ? first.payload.cwd : null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

async function fileMatchesSessionId(file: string, id: string): Promise<boolean> {
  const meta = await readSessionMetaRecord(file);
  return meta?.sessionId === id;
}

export async function findSessionFileById(id: string, codexHome = join(homedir(), '.codex')): Promise<string | null> {
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return null;

  // Only try ripgrep if it's available
  if (await isRipgrepAvailable()) {
    try {
      const { stdout } = await execFileAsync(
        'rg',
        ['-l', '--fixed-strings', `"${id}"`, sessionsDir],
      );
      const files = stdout.trim().split('\n').filter(Boolean);
      for (const file of files) {
        if (await fileMatchesSessionId(file, id)) return file;
      }
    } catch {
      // fall back to slower in-process scan
    }
  }

  const files: string[] = [];
  for await (const entry of glob(join(sessionsDir, '**/*.jsonl'))) {
    files.push(entry);
  }
  for (const file of files) {
    if (await fileMatchesSessionId(file, id)) return file;
  }
  return null;
}

export function isSubpathOfProject(cwd: string, projectPath: string): boolean {
  const normalizedCwd = resolve(cwd);
  const normalizedProject = resolve(projectPath);
  return (
    normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}${sep}`)
  );
}

export async function listCodexSessionsForProjects(
  projectPaths: string[],
  codexHome = join(homedir(), '.codex'),
): Promise<CodexDiscoveredSession[]> {
  const indexed = await readSessionIndex(codexHome);
  const normalizedProjects = projectPaths.map((p) => resolve(p));
  const out: CodexDiscoveredSession[] = [];

  for (const row of indexed) {
    try {
      const file = await findSessionFileById(row.id, codexHome);
      if (!file) continue;
      const meta = await readSessionMetaRecord(file);
      if (!meta || meta.sessionId !== row.id || !meta.cwd) continue;
      const cwd = meta.cwd;

      const matches = normalizedProjects.filter((projectPath) =>
        isSubpathOfProject(cwd, projectPath),
      );
      if (matches.length === 0) continue;
      matches.sort((a, b) => b.length - a.length);

      out.push({
        id: row.id,
        threadName: row.threadName,
        updatedAt: row.updatedAt,
        cwd: resolve(cwd),
        projectPath: matches[0],
      });
    } catch {
      // skip this session
    }
  }

  return out;
}
