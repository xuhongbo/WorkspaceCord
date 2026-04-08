import { describe, expect, it } from 'vitest';

describe('session-message-context', () => {
  it('生成稳定的 discord 语义提示片段', async () => {
    const mod = await import('@workspacecord/bot/discord/session-message-context');
    const text = mod.buildDiscordSessionMessageContext();

    expect(text).toContain('Discord');
    expect(text).toContain('附件默认不自动下载');
    expect(text).toContain('workspacecord attachment fetch');
    expect(text).toContain('session_id');
    expect(text).toContain('message_id');
    expect(text).toContain('attachment_id');
    expect(text).toContain('--all');
    expect(text).toContain('长任务完成');
    expect(text).toContain('新的可见消息');
  });
});
