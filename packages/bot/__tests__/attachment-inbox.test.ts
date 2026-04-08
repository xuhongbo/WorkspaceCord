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
    const { _setDataDirForTest } = await import('@workspacecord/core/persistence');
    _setDataDirForTest(dataDir);
  });

  afterEach(async () => {
    const { _setDataDirForTest } = await import('@workspacecord/core/persistence');
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
        currentSessionId: 'session-1',
      }),
    ).rejects.toThrow('attachmentId');
  });

  it('未提供 currentSessionId 时拒绝下载', async () => {
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
      }),
    ).rejects.toThrow('currentSessionId is required');
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

  it('--all 模式超出总大小被拦截', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');
    vi.stubGlobal('fetch', vi.fn());
    await mod.registerMessageAttachments('session-3', 'msg-3', [
      {
        id: 'att-1',
        name: 'large1.bin',
        contentType: 'application/octet-stream',
        size: 60 * 1024 * 1024,
        url: 'https://example.test/large1.bin',
      },
      {
        id: 'att-2',
        name: 'large2.bin',
        contentType: 'application/octet-stream',
        size: 60 * 1024 * 1024,
        url: 'https://example.test/large2.bin',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-3',
        messageId: 'msg-3',
        all: true,
        currentSessionId: 'session-3',
      }),
    ).rejects.toThrow('Total attachment size exceeds --all limit');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('拒绝非 HTTP/HTTPS 协议', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');
    const { _setDataDirForTest } = await import('@workspacecord/core/persistence');
    await mod.registerMessageAttachments('session-4', 'msg-4', [
      {
        id: 'att-1',
        name: 'file.bin',
        contentType: 'application/octet-stream',
        size: 1,
        url: 'ftp://example.test/file.bin',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-4',
        messageId: 'msg-4',
        attachmentId: 'att-1',
        currentSessionId: 'session-4',
      }),
    ).rejects.toThrow('Attachment URL must use http or https');
  });

  it('下载超时会报错', async () => {
    process.env.WORKSPACECORD_ATTACHMENT_FETCH_TIMEOUT_MS = '10';
    vi.resetModules();
    const { _setDataDirForTest } = await import('@workspacecord/core/persistence');
    _setDataDirForTest(dataDir);
    const mod = await import('../src/discord/attachment-inbox.ts');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () =>
          new Promise<ArrayBuffer>((resolve) =>
            setTimeout(() => resolve(new TextEncoder().encode('timeout').buffer), 50),
          ),
      })),
    );

    await mod.registerMessageAttachments('session-5', 'msg-5', [
      {
        id: 'att-1',
        name: 'slow.bin',
        contentType: 'application/octet-stream',
        size: 1,
        url: 'https://example.test/slow.bin',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-5',
        messageId: 'msg-5',
        attachmentId: 'att-1',
        currentSessionId: 'session-5',
      }),
    ).rejects.toThrow('Attachment download timed out');

    delete process.env.WORKSPACECORD_ATTACHMENT_FETCH_TIMEOUT_MS;
  });

  it('请求建立阶段超时也会报错', async () => {
    process.env.WORKSPACECORD_ATTACHMENT_FETCH_TIMEOUT_MS = '10';
    vi.resetModules();
    const { _setDataDirForTest } = await import('@workspacecord/core/persistence');
    _setDataDirForTest(dataDir);
    const mod = await import('../src/discord/attachment-inbox.ts');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  ok: true,
                  arrayBuffer: async () => new TextEncoder().encode('late').buffer,
                }),
              50,
            ),
          ),
      ),
    );

    await mod.registerMessageAttachments('session-6', 'msg-6', [
      {
        id: 'att-1',
        name: 'late.bin',
        contentType: 'application/octet-stream',
        size: 1,
        url: 'https://example.test/late.bin',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-6',
        messageId: 'msg-6',
        attachmentId: 'att-1',
        currentSessionId: 'session-6',
      }),
    ).rejects.toThrow('Attachment download timed out');

    delete process.env.WORKSPACECORD_ATTACHMENT_FETCH_TIMEOUT_MS;
  });

  it('实际下载体积超过限制时会中止', async () => {
    const mod = await import('../src/discord/attachment-inbox.ts');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array(26 * 1024 * 1024).buffer,
      })),
    );

    await mod.registerMessageAttachments('session-7', 'msg-7', [
      {
        id: 'att-1',
        name: 'huge.bin',
        contentType: 'application/octet-stream',
        size: 1,
        url: 'https://example.test/huge.bin',
      },
    ]);

    await expect(
      mod.fetchRegisteredAttachments({
        sessionId: 'session-7',
        messageId: 'msg-7',
        attachmentId: 'att-1',
        currentSessionId: 'session-7',
      }),
    ).rejects.toThrow('Attachment exceeds 25MB limit');
  });
});
