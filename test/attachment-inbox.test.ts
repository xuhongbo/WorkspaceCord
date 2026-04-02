import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let dataDir = '';

function fileFromDataDir(...parts: string[]): string {
  return join(dataDir, ...parts);
}

describe('attachment-inbox', () => {
  beforeEach(async () => {
    vi.resetModules();
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-attachment-inbox-'));
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(dataDir);
  });

  afterEach(async () => {
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('按 session 与 message 持久化附件摘要', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');

    await mod.registerMessageAttachments('session-1', 'msg-1', [
      {
        id: 'att-1',
        name: 'note.md',
        contentType: 'text/markdown',
        size: 12,
        url: 'https://example.test/note.md',
      },
    ]);

    const records = await mod.getMessageAttachments('session-1', 'msg-1');
    expect(records).toEqual([
      expect.objectContaining({
        attachmentId: 'att-1',
        name: 'note.md',
        contentType: 'text/markdown',
        sizeBytes: 12,
      }),
    ]);

    const persisted = JSON.parse(readFileSync(fileFromDataDir('attachment-inbox.json'), 'utf8'));
    expect(persisted['session-1:msg-1']).toHaveLength(1);
  });

  it('下载单个附件到 inbox 目录并净化文件名', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode('hello attachment').buffer,
      })),
    );

    await mod.registerMessageAttachments('session-1', 'msg-1', [
      {
        id: 'att-1',
        name: '../note?.md',
        contentType: 'text/markdown',
        size: 16,
        url: 'https://example.test/note.md',
      },
    ]);

    const downloaded = await mod.fetchRegisteredAttachments({
      sessionId: 'session-1',
      messageId: 'msg-1',
      attachmentId: 'att-1',
      currentSessionId: 'session-1',
    });

    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].path).toContain('/inbox/session-1/');
    expect(downloaded[0].path).not.toContain('..');
    expect(existsSync(downloaded[0].path)).toBe(true);
    expect(readFileSync(downloaded[0].path, 'utf8')).toBe('hello attachment');
    const audit = JSON.parse(readFileSync(fileFromDataDir('attachment-download-audit.json'), 'utf8'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      sessionId: 'session-1',
      messageId: 'msg-1',
      attachmentId: 'att-1',
      all: false,
    });
  });

  it('未指定 --all 时缺少 attachmentId 会报错', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');
    await mod.registerMessageAttachments('session-1', 'msg-1', [
      {
        id: 'att-1',
        name: 'note.md',
        contentType: 'text/markdown',
        size: 12,
        url: 'https://example.test/note.md',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-1',
        messageId: 'msg-1',
      }),
    ).rejects.toThrow('attachmentId');
  });

  it('不允许 currentSessionId 与目标 sessionId 不一致', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');
    await mod.registerMessageAttachments('session-1', 'msg-1', [
      {
        id: 'att-1',
        name: 'note.md',
        contentType: 'text/markdown',
        size: 12,
        url: 'https://example.test/note.md',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-1',
        messageId: 'msg-1',
        attachmentId: 'att-1',
        currentSessionId: 'session-2',
      }),
    ).rejects.toThrow('current session mismatch');
  });
});
