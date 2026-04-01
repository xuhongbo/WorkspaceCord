import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, existsSyncMock, getConfigValueMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn() })),
  existsSyncMock: vi.fn(() => true),
  getConfigValueMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('../src/global-config.ts', () => ({
  getConfigValue: getConfigValueMock,
}));

describe('codex-launcher', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.CODEX_PATH;
    existsSyncMock.mockReturnValue(true);
    getConfigValueMock.mockReturnValue(undefined);
  });

  it('优先使用环境变量 CODEX_PATH', async () => {
    process.env.CODEX_PATH = '/custom/env-codex';
    getConfigValueMock.mockReturnValue('/custom/config-codex');

    const { launchManagedCodex } = await import('../src/cli/codex-launcher.ts');
    await launchManagedCodex({ cwd: '/repo' });

    expect(spawnMock).toHaveBeenCalledWith(
      '/custom/env-codex',
      [],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({
          workspacecord_MANAGED: '1',
          workspacecord_SESSION_CWD: '/repo',
        }),
      }),
    );
  });

  it('环境变量缺失时回退到全局配置 CODEX_PATH', async () => {
    getConfigValueMock.mockImplementation((key: string) =>
      key === 'CODEX_PATH' ? '/custom/config-codex' : undefined,
    );

    const { launchManagedCodex } = await import('../src/cli/codex-launcher.ts');
    await launchManagedCodex({ cwd: '/repo' });

    expect(spawnMock).toHaveBeenCalledWith(
      '/custom/config-codex',
      [],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('环境变量与全局配置都缺失时回退到默认 codex', async () => {
    const { launchManagedCodex } = await import('../src/cli/codex-launcher.ts');
    await launchManagedCodex({ cwd: '/repo' });

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      [],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});
