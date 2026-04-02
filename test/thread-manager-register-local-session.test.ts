import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelType, type Guild } from 'discord.js';

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
});
