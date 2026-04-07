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

  it('工作目录不存在时退出进程', async () => {
    existsSyncMock.mockReturnValue(false);
    const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const consoleErrorMock = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { launchManagedCodex } = await import('../src/cli/codex-launcher.ts');
    await launchManagedCodex({ cwd: '/nonexistent' });

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(consoleErrorMock).toHaveBeenCalledWith(expect.stringContaining('工作目录不存在'));

    exitMock.mockRestore();
    consoleErrorMock.mockRestore();
  });

  it('传递 model 和 sandbox 模式参数', async () => {
    const { launchManagedCodex } = await import('../src/cli/codex-launcher.ts');
    await launchManagedCodex({
      cwd: '/repo',
      model: 'gpt-4',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });

    const args = spawnMock.mock.calls[0][1];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4');
    expect(args).toContain('--sandbox-mode');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--approval-policy');
    expect(args).toContain('on-request');
  });

  it('附加用户自定义参数', async () => {
    const { launchManagedCodex } = await import('../src/cli/codex-launcher.ts');
    await launchManagedCodex({
      cwd: '/repo',
      args: ['--verbose', '--config', 'custom.json'],
    });

    const args = spawnMock.mock.calls[0][1];
    expect(args).toContain('--verbose');
    expect(args).toContain('--config');
    expect(args).toContain('custom.json');
  });

  it('isManagedSession 检测环境变量标记', async () => {
    const { isManagedSession } = await import('../src/cli/codex-launcher.ts');

    process.env.workspacecord_MANAGED = '1';
    expect(isManagedSession()).toBe(true);

    delete process.env.workspacecord_MANAGED;
    expect(isManagedSession()).toBe(false);
  });

  it('getManagedSessionCwd 返回环境变量中的工作目录', async () => {
    const { getManagedSessionCwd } = await import('../src/cli/codex-launcher.ts');

    process.env.workspacecord_SESSION_CWD = '/my/project';
    expect(getManagedSessionCwd()).toBe('/my/project');

    delete process.env.workspacecord_SESSION_CWD;
    expect(getManagedSessionCwd()).toBeUndefined();
  });

  it('handleCodexCommand 解析参数并启动会话', async () => {
    const { handleCodexCommand } = await import('../src/cli/codex-launcher.ts');
    await handleCodexCommand(['--cwd', '/my/project', '--model', 'gpt-4o']);

    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['--model', 'gpt-4o']),
      expect.objectContaining({
        cwd: '/my/project',
        env: expect.objectContaining({ workspacecord_SESSION_CWD: '/my/project' }),
      }),
    );
  });

  it('handleCodexCommand 的 --help 仅打印帮助不启动', async () => {
    const consoleLogMock = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handleCodexCommand } = await import('../src/cli/codex-launcher.ts');
    await handleCodexCommand(['--help']);

    expect(consoleLogMock).toHaveBeenCalledWith(expect.stringContaining('workspacecord codex'));
    expect(spawnMock).not.toHaveBeenCalled();

    consoleLogMock.mockRestore();
  });
});
