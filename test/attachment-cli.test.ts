import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRegisteredAttachments = vi.fn();

vi.mock('../src/discord/attachment-inbox.ts', () => ({
  fetchRegisteredAttachments,
}));

describe('attachment-cli', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fetchRegisteredAttachments.mockResolvedValue([
      {
        attachmentId: 'att-1',
        name: 'note.md',
        contentType: 'text/markdown',
        sizeBytes: 12,
        path: '/tmp/note.md',
      },
    ]);
  });

  it('解析 fetch 单附件命令并输出 json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const mod = await import('../src/attachment-cli.ts');

    await mod.handleAttachment([
      'fetch',
      '--session',
      'session-1',
      '--message',
      'msg-1',
      '--attachment',
      'att-1',
    ]);

    expect(fetchRegisteredAttachments).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: 'msg-1',
      attachmentId: 'att-1',
      all: false,
      currentSessionId: undefined,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"path": "/tmp/note.md"'));
  });

  it('解析 --all 模式', async () => {
    const mod = await import('../src/attachment-cli.ts');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await mod.handleAttachment(['fetch', '--session', 'session-1', '--message', 'msg-1', '--all']);

    expect(fetchRegisteredAttachments).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: 'msg-1',
      attachmentId: undefined,
      all: true,
      currentSessionId: undefined,
    });
  });
});


it('解析 --current-session 并透传会话边界', async () => {
  const mod = await import('../src/attachment-cli.ts');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);

  await mod.handleAttachment([
    'fetch',
    '--session',
    'session-1',
    '--message',
    'msg-1',
    '--attachment',
    'att-1',
    '--current-session',
    'session-1',
  ]);

  expect(fetchRegisteredAttachments).toHaveBeenCalledWith({
    sessionId: 'session-1',
    messageId: 'msg-1',
    attachmentId: 'att-1',
    all: false,
    currentSessionId: 'session-1',
  });
});
