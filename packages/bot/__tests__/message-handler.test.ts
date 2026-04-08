import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';

const getSessionByChannel = vi.fn();
const updateSession = vi.fn();
const executeSessionPrompt = vi.fn();
const isUserAllowed = vi.fn();
const sendTyping = vi.fn();
const sendAckReaction = vi.fn();
const buildDeliveryPlan = vi.fn();
const deliver = vi.fn();
const sendSystemNotice = vi.fn();
const relocateSessionPanelToBottom = vi.fn();

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    config: {
      allowedUsers: [],
      allowAllUsers: true,
      rateLimitMs: 1000,
      ackReaction: '👀',
    },
    isUserAllowed,
    isAbortError: vi.fn(() => false),
  };
});
vi.mock('@workspacecord/engine/session-registry', () => ({ getSessionByChannel, updateSession }));
vi.mock('@workspacecord/engine/session-executor', () => ({ executeSessionPrompt }));
vi.mock('../src/discord/delivery-policy.ts', () => ({ buildDeliveryPlan }));
vi.mock('../src/discord/delivery.ts', () => ({ sendTyping, sendAckReaction, deliver }));
vi.mock('../src/discord/delivery-notices.ts', () => ({ sendSystemNotice }));
vi.mock('../src/panel-adapter.ts', () => ({ relocateSessionPanelToBottom }));
// utils mocking handled by @workspacecord/core mock above

const { handleMessage, resetMessageHandlerState } = await import('../src/message-handler.ts');

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    author: { id: 'user-1', bot: false },
    content: 'hello',
    channel: {
      id: 'channel-1',
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(async () => ({ delete: vi.fn(async () => {}) })),
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

  it('正式处理前发送 typing 与确认反应', async () => {
    const message = makeMessage();

    await handleMessage(message as never);

    expect(sendTyping).toHaveBeenCalledWith(message.channel);
    expect(sendAckReaction).toHaveBeenCalledWith(message, '👀');
  });

  it('进入新一轮执行前会先迁移状态与摘要到底部', async () => {
    const message = makeMessage();

    await handleMessage(message as never);

    expect(relocateSessionPanelToBottom).toHaveBeenCalledWith('s1', message.channel);
    expect(executeSessionPrompt).toHaveBeenCalled();
    expect(relocateSessionPanelToBottom.mock.invocationCallOrder[0]).toBeLessThan(
      executeSessionPrompt.mock.invocationCallOrder[0],
    );
  });



  it('在未授权时发送拒绝消息', async () => {
    isUserAllowed.mockReturnValue(false);
    const channel = {
      id: 'channel-1',
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(async () => ({ delete: vi.fn(async () => {}) })),
    };
    const message = makeMessage({ channel });

    await handleMessage(message as never);

    expect(sendSystemNotice).toHaveBeenCalledWith(
      channel,
      's1',
      '你没有权限使用此 Bot。',
    );
    expect(relocateSessionPanelToBottom).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });

  it('在会话生成中时提示稍后再试', async () => {
    const channel = {
      id: 'channel-1',
      type: ChannelType.GuildText,
      isThread: () => false,
      send: vi.fn(async () => ({ delete: vi.fn(async () => {}) })),
    };
    getSessionByChannel.mockReturnValue({ id: 's1', channelId: 'channel-1', type: 'persistent', isGenerating: true });
    const message = makeMessage({ channel });

    await handleMessage(message as never);

    expect(sendSystemNotice).toHaveBeenCalledWith(
      channel,
      's1',
      '*Agent 正在执行中，请先使用 `/agent stop` 停止。*',
      undefined,
    );
    expect(relocateSessionPanelToBottom).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });

  it('把附件摘要而不是附件内容发送给执行器', async () => {
    const attachment = {
      id: 'att-1',
      name: 'note.md',
      url: 'https://example.test/note.md',
      size: 12,
      contentType: 'text/markdown',
    };
    const message = makeMessage({ attachments: new Map([['a1', attachment]]) });

    await handleMessage(message as never);

    expect(executeSessionPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('note.md'),
    );
    expect(executeSessionPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.stringContaining('from file'),
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

    buildDeliveryPlan.mockReturnValue({ mode: 'system_notice', filesOnFirstChunk: [], chunks: ['done'] });
    deliver.mockResolvedValue(['m1']);

    await handleMessage(message as never);

    expect(buildDeliveryPlan).toHaveBeenCalledWith(expect.objectContaining({ mode: 'system_notice' }));
    expect(deliver).toHaveBeenCalledWith(parentChannel, expect.objectContaining({ mode: 'system_notice' }));
    expect(parentChannel.send).not.toHaveBeenCalled();
  });

  it('忽略 bot 作者消息', async () => {
    const message = makeMessage({ author: { id: 'bot-1', bot: true } });

    await handleMessage(message as never);

    expect(executeSessionPrompt).not.toHaveBeenCalled();
  });
});
