import type { AttachmentSummary } from './attachment-inbox.ts';

export type InboundEnvelope = {
  sessionId: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  userId: string;
  username: string;
  timestampIso: string;
  text: string;
  attachments: AttachmentSummary[];
  renderedPrompt: string;
};

export function buildInboundEnvelope(
  input: Omit<InboundEnvelope, 'renderedPrompt'>,
): InboundEnvelope {
  const attrs = [
    `session_id="${input.sessionId}"`,
    `chat_id="${input.chatId}"`,
    `message_id="${input.messageId}"`,
    `user="${input.username}"`,
    `user_id="${input.userId}"`,
    `ts="${input.timestampIso}"`,
  ];
  if (input.replyToMessageId) {
    attrs.push(`reply_to="${input.replyToMessageId}"`);
  }

  const body: string[] = [];
  if (input.text.trim()) {
    body.push(input.text.trim());
  }
  if (input.attachments.length > 0) {
    body.push('', '[attachments]');
    for (const attachment of input.attachments) {
      body.push(
        `- ${attachment.name} | ${attachment.contentType ?? 'unknown'} | ${attachment.sizeBytes} bytes | id=${attachment.attachmentId}`,
      );
    }
    body.push('', '[attachment fetch commands]');
    for (const attachment of input.attachments) {
      body.push(
        `workspacecord attachment fetch --session ${input.sessionId} --message ${input.messageId} --attachment ${attachment.attachmentId}`,
      );
    }
    body.push(
      `workspacecord attachment fetch --session ${input.sessionId} --message ${input.messageId} --all`,
    );
  }

  return {
    ...input,
    renderedPrompt: `<discord ${attrs.join(' ')}>\n${body.join('\n')}\n</discord>`,
  };
}
