import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const getSessionByChannel = vi.fn();
const executeSessionPrompt = vi.fn();
const isUserAllowed = vi.fn();

vi.mock('../src/config.ts', () => ({
  config: {
    allowedUsers: [],
    allowAllUsers: true,
    rateLimitMs: 1000,
  },
}));
vi.mock('../src/thread-manager.ts', () => ({ getSessionByChannel }));
vi.mock('../src/session-executor.ts', () => ({ executeSessionPrompt }));
vi.mock('../src/utils.ts', () => ({
  isUserAllowed,
  isAbortError: vi.fn(() => false),
}));

const { handleMessage, resetMessageHandlerState } = await import('../src/message-handler.ts');

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    author: { id: 'user-1', bot: false },
    content: 'hello',
    channel: {
      id: 'channel-1',
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(),
    },
    attachments: new Map(),
    react: vi.fn(),
    guild: { channels: { cache: new Map() } },
    ...overrides,
  };
}

describe('message-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMessageHandlerState();
    getSessionByChannel.mockReturnValue({
      id: 's1',
      channelId: 'channel-1',
      type: 'persistent',
      isGenerating: false,
    });
    isUserAllowed.mockReturnValue(true);
  });

  it('对同一用户同一频道的短时间重复消息执行限流', async () => {
    const message = makeMessage();

    await handleMessage(message as never);
    await handleMessage(message as never);

    expect(executeSessionPrompt).toHaveBeenCalledTimes(1);
  });



  it('在未授权时发送拒绝消息', async () => {
    isUserAllowed.mockReturnValue(false);
    const channel = {
      id: 'channel-1',
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(async () => undefined),
    };
    const message = makeMessage({ channel });

    await handleMessage(message as never);

    expect(channel.send).toHaveBeenCalledWith('You are not authorized to use this bot.');
    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });

  it('在会话生成中时提示稍后再试', async () => {
    const channel = {
      id: 'channel-1',
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(async () => undefined),
    };
    getSessionByChannel.mockReturnValue({ id: 's1', channelId: 'channel-1', type: 'persistent', isGenerating: true });
    const message = makeMessage({ channel });

    await handleMessage(message as never);

    expect(channel.send).toHaveBeenCalledWith('*Agent is already generating. Stop it first with `/agent stop`.*');
    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });

  it('读取文本附件并与正文一起发送给执行器', async () => {
    const attachment = { name: 'note.md', url: 'https://example.test/note.md', size: 12 };
    const message = makeMessage({ attachments: new Map([['a1', attachment]]) });
    global.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('from file').buffer })) as never;

    await handleMessage(message as never);

    expect(executeSessionPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: '[note.md]\nfrom file' },
      ],
    );
  });

  it('子代理完成后通知父频道', async () => {
    const parentChannel = {
      id: 'parent-1',
      isTextBased: () => true,
      isThread: () => false,
      send: vi.fn(async () => undefined),
    };
    getSessionByChannel.mockReturnValue({ id: 's1', channelId: 'channel-1', type: 'subagent', isGenerating: false, parentChannelId: 'parent-1', agentLabel: 'worker' });
    const message = makeMessage({ guild: { channels: { cache: new Map([['parent-1', parentChannel]]) } } });

    await handleMessage(message as never);

    expect(parentChannel.send).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('忽略 bot 作者消息', async () => {
    const message = makeMessage({ author: { id: 'bot-1', bot: true } });

    await handleMessage(message as never);

    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });
});
