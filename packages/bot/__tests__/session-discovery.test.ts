import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerLocalSession = vi.fn();

vi.mock('../src/session-local-registration.ts', () => ({
  registerLocalSession,
}));

const { discoverAndRegisterSession } = await import('../src/session-discovery.ts');

describe('session-discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('没有 guild 时返回 null', async () => {
    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => undefined),
        },
      },
    };

    const result = await discoverAndRegisterSession(client as never, {
      provider: 'claude',
      providerSessionId: 'session-1',
      cwd: '/repo',
      discoverySource: 'claude-hook',
    });

    expect(result).toBeNull();
    expect(registerLocalSession).not.toHaveBeenCalled();
  });

  it('统一委托给 registerLocalSession 并返回映射结果', async () => {
    const guild = { id: 'g-1' };
    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };
    registerLocalSession.mockResolvedValue({
      session: { id: 's-1', channelId: 'c-1' },
      isNewlyCreated: false,
    });

    const result = await discoverAndRegisterSession(client as never, {
      provider: 'codex',
      providerSessionId: 'session-2',
      cwd: '/repo/pkg',
      discoverySource: 'codex-log',
    });

    expect(registerLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        providerSessionId: 'session-2',
        cwd: '/repo/pkg',
        discoverySource: 'codex-log',
        remoteHumanControl: false,
      }),
      guild,
    );
    expect(result).toEqual({
      sessionId: 's-1',
      channelId: 'c-1',
      isNew: false,
    });
  });

  it('会把 Claude 子代理元数据透传给 registerLocalSession', async () => {
    const guild = { id: 'g-2' };
    const client = {
      guilds: {
        cache: {
          first: vi.fn(() => guild),
        },
      },
    };
    registerLocalSession.mockResolvedValue({
      session: { id: 'sub-1', channelId: 'thread-1' },
      isNewlyCreated: true,
    });

    const result = await discoverAndRegisterSession(client as never, {
      provider: 'claude',
      providerSessionId: 'parent-session',
      cwd: '/repo',
      discoverySource: 'claude-hook',
      subagent: {
        parentProviderSessionId: 'parent-session',
        agentId: 'agent-1',
        agentType: 'Explore',
      },
    });

    expect(registerLocalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        providerSessionId: 'parent-session',
        subagent: {
          parentProviderSessionId: 'parent-session',
          agentId: 'agent-1',
          agentType: 'Explore',
        },
      }),
      guild,
    );
    expect(result).toEqual({
      sessionId: 'sub-1',
      channelId: 'thread-1',
      isNew: true,
    });
  });
});
