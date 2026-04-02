import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  readSessionIndex,
  findSessionFileById,
  listCodexSessionsForProjects,
} from '../src/codex-session-discovery.ts';

describe('codex-session-discovery', () => {
  it('reads index and locates session file', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(codexHome, 'sessions', '2026', '03'), { recursive: true });
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'abc', thread_name: 'feature x', updated_at: 123 }),
        JSON.stringify({ thread_name: 'missing id' }),
      ].join('\n'),
    );
    writeFileSync(
      join(codexHome, 'sessions', '2026', '03', 'one.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo/a' }, id: 'abc' })}\n${JSON.stringify({ type: 'user', text: 'hi' })}`,
    );

    const index = await readSessionIndex(codexHome);
    expect(index).toHaveLength(1);
    expect(index[0].threadName).toBe('feature x');

    const file = await findSessionFileById('abc', codexHome);
    expect(file).toContain('one.jsonl');
  });

  it('parses ISO updated_at values from the Codex session index', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(codexHome, 'sessions', '2026', '03'), { recursive: true });
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({
        id: 'iso-1',
        thread_name: 'iso thread',
        updated_at: '2026-04-02T06:52:03.397718Z',
      }),
    );
    writeFileSync(
      join(codexHome, 'sessions', '2026', '03', 'iso.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'iso-1', cwd: '/repo/iso' },
      }),
    );

    const index = await readSessionIndex(codexHome);
    expect(index).toHaveLength(1);
    expect(index[0].updatedAt).toBeTypeOf('number');
    expect(index[0].updatedAt).toBeGreaterThan(0);
  });

  it('does not false-match another file that merely references the session id in later content', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(codexHome, 'sessions', '2026', '03'), { recursive: true });
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'target-session', thread_name: 'target', updated_at: 123 }),
    );
    writeFileSync(
      join(codexHome, 'sessions', '2026', '03', 'wrong.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'other-session', cwd: '/repo/other' },
        }),
        JSON.stringify({ type: 'user', text: 'mentioning target-session in body' }),
      ].join('\n'),
    );
    writeFileSync(
      join(codexHome, 'sessions', '2026', '03', 'right.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'target-session', cwd: '/repo/right' },
      }),
    );

    const file = await findSessionFileById('target-session', codexHome);
    expect(file).toContain('right.jsonl');
  });

  it('filters by mounted project path', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });

    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'sid-1', thread_name: 'thread 1', updated_at: 1 }),
    );
    writeFileSync(
      join(codexHome, 'sessions', 's.jsonl'),
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/work/project-a/sub' },
        id: 'sid-1',
      }),
    );

    const sessions = await listCodexSessionsForProjects(
      ['/work/project-a', '/work/project-b'],
      codexHome,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectPath).toBe('/work/project-a');
  });
});
