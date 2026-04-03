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

type InboundPayload = {
  metadata: {
    session_id: string;
    chat_id: string;
    message_id: string;
    reply_to_message_id: string | null;
    user: string;
    user_id: string;
    ts: string;
  };
  text: string;
  attachments: Array<{
    attachment_id: string;
    name: string;
    content_type: string | null;
    size_bytes: number;
  }>;
  attachment_fetch_commands: {
    per_attachment: string[];
    fetch_all: string;
  };
};

export function buildInboundEnvelope(
  input: Omit<InboundEnvelope, 'renderedPrompt'>,
): InboundEnvelope {
  const metadata = {
    session_id: input.sessionId,
    chat_id: input.chatId,
    message_id: input.messageId,
    reply_to_message_id: input.replyToMessageId ?? null,
    user: input.username,
    user_id: input.userId,
    ts: input.timestampIso,
  };

  const normalizedText = input.text ?? '';
  const commands = input.attachments.map(
    (attachment) =>
      `workspacecord attachment fetch --session ${input.sessionId} --message ${input.messageId} --attachment ${attachment.attachmentId}`,
  );
  const payload: InboundPayload = {
    metadata,
    text: normalizedText,
    attachments: input.attachments.map((attachment) => ({
      attachment_id: attachment.attachmentId,
      name: attachment.name,
      content_type: attachment.contentType ?? null,
      size_bytes: attachment.sizeBytes,
    })),
    attachment_fetch_commands: {
      per_attachment: commands,
      fetch_all: `workspacecord attachment fetch --session ${input.sessionId} --message ${input.messageId} --all`,
    },
  };

  const renderedPrompt = `<discord>\n${JSON.stringify(payload, null, 2)}\n</discord>`;

  return {
    ...input,
    renderedPrompt,
  };
}
