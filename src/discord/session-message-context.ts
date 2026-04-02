export function buildDiscordSessionMessageContext(): string {
  return [
    '当前会话中的消息来自 Discord。',
    '消息包中的 [attachments] 块会暴露 session_id、message_id 与 attachment_id，足以构成 `workspacecord attachment fetch --session <session-id> --message <message-id> --attachment <attachment-id>` 或 `workspacecord attachment fetch --session <session-id> --message <message-id> --all`。',
    '附件默认不自动下载，你首先只会看到附件摘要。',
    '如果你需要查看附件内容，请通过上述本地命令获取。',
    '正常回复时不需要反复引用最新一条 Discord 消息。',
    '长任务完成后，必须发送新的可见消息，不要只依赖编辑旧的进度消息。',
  ].join(' ');
}
