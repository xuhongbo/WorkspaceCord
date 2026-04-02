import { describe, expect, it } from 'vitest';

describe('inbound-envelope', () => {
  it('把正文与附件摘要渲染成统一 discord 消息包', async () => {
    const mod = await import('../src/discord/inbound-envelope.ts');

    const envelope = mod.buildInboundEnvelope({
      sessionId: 'session-1',
      chatId: 'chat-1',
      messageId: 'msg-1',
      replyToMessageId: 'msg-0',
      userId: 'user-1',
      username: 'alice',
      timestampIso: '2026-04-02T08:00:00.000Z',
      text: 'hello',
      attachments: [
        {
          attachmentId: 'att-1',
          name: 'note.md',
          contentType: 'text/markdown',
          sizeBytes: 12,
        },
      ],
    });

    expect(envelope.renderedPrompt).toContain('<discord session_id="session-1" chat_id="chat-1" message_id="msg-1"');
    expect(envelope.renderedPrompt).toContain('hello');
    expect(envelope.renderedPrompt).toContain('note.md');
    expect(envelope.renderedPrompt).toContain('text/markdown');
    expect(envelope.renderedPrompt).toContain('12');
    expect(envelope.renderedPrompt).toContain(
      'workspacecord attachment fetch --session session-1 --message msg-1 --attachment att-1',
    );
    expect(envelope.renderedPrompt).toContain('--all');
    expect(envelope.renderedPrompt).not.toContain('from file');
  });
});
