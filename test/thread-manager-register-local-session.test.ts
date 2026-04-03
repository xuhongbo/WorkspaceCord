import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelType, ThreadAutoArchiveDuration, type Guild } from 'discord.js';

vi.mock('../src/providers/index.ts', () => ({
  ensureProvider: vi.fn(async () => undefined),
}));

vi.mock('../src/config.ts', () => ({
  config: {
    defaultMode: 'auto',
  },
}));

describe('thread-manager registerLocalSession', () => {
  let dataDir = '';
  let rootDir = '';
  let appDir = '';

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/archive-manager.ts', () => ({
      isArchivedProviderSession: vi.fn(() => false),
    }));
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-reg-local-data-'));
    rootDir = mkdtempSync(join(tmpdir(), 'workspacecord-reg-local-root-'));
    appDir = join(rootDir, 'packages', 'app');
    mkdirSync(join(appDir, 'src'), { recursive: true });
  });

  afterEach(async () => {
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('嵌套项目场景下优先归属到最长路径匹配的项目', async () => {
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(dataDir);

    const projectRegistry = await import('../src/project-registry.ts');
    const threadManager = await import('../src/thread-manager.ts');

    await projectRegistry.loadRegistry();
    await projectRegistry.registerProject('root-project', rootDir);
    await projectRegistry.bindProjectCategory('root-project', 'cat-root', 'Root Category');
    await projectRegistry.registerProject('app-project', appDir);
    await projectRegistry.bindProjectCategory('app-project', 'cat-app', 'App Category');

    const rootCategory = {
      id: 'cat-root',
      type: ChannelType.GuildCategory,
      children: { cache: { find: vi.fn(() => undefined) } },
    };
    const appCategory = {
      id: 'cat-app',
      type: ChannelType.GuildCategory,
      children: { cache: { find: vi.fn(() => undefined) } },
    };
    const createChannel = vi.fn(async ({ parent }: { parent: string }) => ({
      id: `channel-${parent}`,
      parentId: parent,
      topic: 'codex session (local) | Provider Session: provider-1',
    }));
    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => {
            if (id === 'cat-root') return rootCategory;
            if (id === 'cat-app') return appCategory;
            return undefined;
          }),
        },
        create: createChannel,
      },
    } as unknown as Guild;

    const result = await threadManager.registerLocalSession(
      {
        provider: 'codex',
        providerSessionId: 'provider-1',
        cwd: join(appDir, 'src'),
        discoverySource: 'codex-log',
      },
      guild,
    );

    expect(result?.session.projectName).toBe('app-project');
    expect(result?.session.categoryId).toBe('cat-app');
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: 'cat-app',
      }),
    );
  });

  it('已归档的 provider 会话不会被自动重新注册', async () => {
    vi.doMock('../src/archive-manager.ts', () => ({
      isArchivedProviderSession: vi.fn(() => true),
    }));

    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(dataDir);

    const projectRegistry = await import('../src/project-registry.ts');
    const threadManager = await import('../src/thread-manager.ts');

    await projectRegistry.loadRegistry();
    await projectRegistry.registerProject('demo-project', rootDir);
    await projectRegistry.bindProjectCategory('demo-project', 'cat-demo', 'Demo Category');

    const demoCategory = {
      id: 'cat-demo',
      type: ChannelType.GuildCategory,
      children: { cache: { find: vi.fn(() => undefined) } },
    };
    const createChannel = vi.fn(async ({ parent }: { parent: string }) => ({
      id: `channel-${parent}`,
      parentId: parent,
      topic: 'codex session (local) | Provider Session: provider-archived',
    }));
    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => (id === 'cat-demo' ? demoCategory : undefined)),
        },
        create: createChannel,
      },
    } as unknown as Guild;

    const result = await threadManager.registerLocalSession(
      {
        provider: 'codex',
        providerSessionId: 'provider-archived',
        cwd: rootDir,
        discoverySource: 'codex-log',
      },
      guild,
    );

    expect(result).toBeNull();
    expect(createChannel).not.toHaveBeenCalled();
  });

  it('子代理元数据命中父会话时会在父频道下创建线程', async () => {
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(dataDir);

    const projectRegistry = await import('../src/project-registry.ts');
    const threadManager = await import('../src/thread-manager.ts');

    await projectRegistry.loadRegistry();
    await projectRegistry.registerProject('demo-project', rootDir);
    await projectRegistry.bindProjectCategory('demo-project', 'cat-demo', 'Demo Category');

    await threadManager.createSession({
      channelId: 'parent-channel',
      categoryId: 'cat-demo',
      projectName: 'demo-project',
      agentLabel: 'parent',
      provider: 'codex',
      providerSessionId: 'parent-provider',
      directory: rootDir,
      type: 'persistent',
    });

    const demoCategory = {
      id: 'cat-demo',
      type: ChannelType.GuildCategory,
      children: { cache: { find: vi.fn(() => undefined) } },
    };
    const createThread = vi.fn(async () => ({ id: 'thread-child-1' }));
    const parentChannel = {
      id: 'parent-channel',
      type: ChannelType.GuildText,
      threads: {
        create: createThread,
      },
    };
    const createChannel = vi.fn(async ({ parent }: { parent: string }) => ({
      id: `channel-${parent}`,
      parentId: parent,
      topic: 'codex session (local) | Provider Session: child-provider',
    }));
    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => {
            if (id === 'cat-demo') return demoCategory;
            if (id === 'parent-channel') return parentChannel;
            return undefined;
          }),
        },
        create: createChannel,
      },
    } as unknown as Guild;

    const result = await threadManager.registerLocalSession(
      {
        provider: 'codex',
        providerSessionId: 'child-provider',
        cwd: rootDir,
        discoverySource: 'codex-log',
        subagent: {
          parentProviderSessionId: 'parent-provider',
          depth: 1,
        },
      },
      guild,
    );

    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('[sub:codex]'),
        type: ChannelType.PublicThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      }),
    );
    expect(createChannel).not.toHaveBeenCalled();
    expect(result?.session.type).toBe('subagent');
    expect(result?.session.parentChannelId).toBe('parent-channel');
    expect(result?.session.channelId).toBe('thread-child-1');
    expect(result?.session.subagentDepth).toBe(1);
  });

  it('Claude 子代理会使用 agentId 生成独立 providerSessionId', async () => {
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(dataDir);

    const projectRegistry = await import('../src/project-registry.ts');
    const threadManager = await import('../src/thread-manager.ts');

    await projectRegistry.loadRegistry();
    await projectRegistry.registerProject('demo-project', rootDir);
    await projectRegistry.bindProjectCategory('demo-project', 'cat-demo', 'Demo Category');

    await threadManager.createSession({
      channelId: 'parent-channel',
      categoryId: 'cat-demo',
      projectName: 'demo-project',
      agentLabel: 'parent',
      provider: 'claude',
      providerSessionId: 'claude-parent',
      directory: rootDir,
      type: 'persistent',
    });

    const demoCategory = {
      id: 'cat-demo',
      type: ChannelType.GuildCategory,
      children: { cache: { find: vi.fn(() => undefined) } },
    };
    const createThread = vi.fn(async () => ({ id: 'thread-claude-child' }));
    const parentChannel = {
      id: 'parent-channel',
      type: ChannelType.GuildText,
      threads: {
        create: createThread,
      },
    };
    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => {
            if (id === 'cat-demo') return demoCategory;
            if (id === 'parent-channel') return parentChannel;
            return undefined;
          }),
        },
        create: vi.fn(),
      },
    } as unknown as Guild;

    const result = await threadManager.registerLocalSession(
      {
        provider: 'claude',
        providerSessionId: 'claude-parent',
        cwd: rootDir,
        discoverySource: 'claude-hook',
        subagent: {
          parentProviderSessionId: 'claude-parent',
          agentId: 'agent-1',
          agentType: 'Explore',
        },
      },
      guild,
    );

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(result?.session.providerSessionId).toBe('subagent:claude-parent:agent-1');
    expect(result?.session.type).toBe('subagent');
    expect(result?.session.parentChannelId).toBe('parent-channel');
  });

  it('父会话位于线程内时也能继续注册下级子代理', async () => {
    const { _setDataDirForTest } = await import('../src/persistence.ts');
    _setDataDirForTest(dataDir);

    const projectRegistry = await import('../src/project-registry.ts');
    const threadManager = await import('../src/thread-manager.ts');

    await projectRegistry.loadRegistry();
    await projectRegistry.registerProject('demo-project', rootDir);
    await projectRegistry.bindProjectCategory('demo-project', 'cat-demo', 'Demo Category');

    await threadManager.createSession({
      channelId: 'parent-thread',
      categoryId: 'cat-demo',
      projectName: 'demo-project',
      agentLabel: 'parent-subagent',
      provider: 'codex',
      providerSessionId: 'parent-subagent-provider',
      directory: rootDir,
      type: 'subagent',
      parentChannelId: 'root-channel',
      subagentDepth: 1,
    });

    const demoCategory = {
      id: 'cat-demo',
      type: ChannelType.GuildCategory,
      children: { cache: { find: vi.fn(() => undefined) } },
    };
    const createThread = vi.fn(async () => ({ id: 'thread-grandchild' }));
    const rootChannel = {
      id: 'root-channel',
      type: ChannelType.GuildText,
      threads: {
        create: createThread,
      },
    };
    const parentThread = {
      id: 'parent-thread',
      type: ChannelType.PublicThread,
      parent: rootChannel,
    };
    const guild = {
      channels: {
        cache: {
          get: vi.fn((id: string) => {
            if (id === 'cat-demo') return demoCategory;
            if (id === 'parent-thread') return parentThread;
            if (id === 'root-channel') return rootChannel;
            return undefined;
          }),
        },
        create: vi.fn(),
      },
    } as unknown as Guild;

    const result = await threadManager.registerLocalSession(
      {
        provider: 'codex',
        providerSessionId: 'grandchild-provider',
        cwd: rootDir,
        discoverySource: 'codex-log',
        subagent: {
          parentProviderSessionId: 'parent-subagent-provider',
          depth: 2,
        },
      },
      guild,
    );

    expect(createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining('[sub:codex]'),
        type: ChannelType.PublicThread,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      }),
    );
    expect(result?.session.type).toBe('subagent');
    expect(result?.session.parentChannelId).toBe('root-channel');
    expect(result?.session.channelId).toBe('thread-grandchild');
    expect(result?.session.subagentDepth).toBe(2);
  });
});
