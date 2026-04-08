import { describe, expect, it, vi } from 'vitest';

describe('global-config production fallback', () => {
  it('非测试环境下主配置路径失败时不应回退到仓库内测试文件', async () => {
    vi.resetModules();
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;
    const originalConfigDir = process.env.WORKSPACECORD_CONFIG_DIR;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    process.env.WORKSPACECORD_CONFIG_DIR = '/root/forbidden';

    const calls: string[] = [];

    vi.doMock('configstore', () => ({
      default: class MockConfigstore {
        path: string;

        constructor(_id: string, _defaults: unknown, options: { configPath?: string }) {
          this.path = options.configPath ?? '';
          calls.push(this.path);
          throw new Error(`boom:${this.path}`);
        }
      },
    }));

    try {
      const mod = await import('../src/global-config.ts');
      expect(() => mod.getConfigPath()).toThrow('boom:/root/forbidden/config.json');
      expect(calls).toEqual(['/root/forbidden/config.json']);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = originalVitest;
      if (originalConfigDir === undefined) delete process.env.WORKSPACECORD_CONFIG_DIR;
      else process.env.WORKSPACECORD_CONFIG_DIR = originalConfigDir;
      vi.doUnmock('configstore');
    }
  });
});
