import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================
// Hoisted mocks — must be defined before any imports
// ============================================================

const mocks = vi.hoisted(() => ({
  // global-config
  getAllConfig: vi.fn(),
  getConfigPath: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  deleteConfigValue: vi.fn(),
  validateConfigValue: vi.fn().mockReturnValue(null),
  maskSensitive: vi.fn((_key: string, value: string) => value),
  SENSITIVE_KEYS: new Set(['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY']),
  VALID_KEYS: new Set(['DISCORD_TOKEN', 'DEFAULT_PROVIDER', 'DEFAULT_MODE']),

  // project-registry
  loadRegistry: vi.fn().mockResolvedValue(undefined),
  registerProject: vi.fn(),
  getAllRegisteredProjects: vi.fn(),
  getProjectByPath: vi.fn(),
  renameProject: vi.fn().mockResolvedValue(undefined),
  removeProject: vi.fn().mockResolvedValue(undefined),
  unbindProjectCategory: vi.fn().mockResolvedValue(undefined),

  // attachment-inbox
  fetchRegisteredAttachments: vi.fn(),

  // daemon — child_process
  execSync: vi.fn(),
  execFile: vi.fn(),

  // daemon — os
  platform: vi.fn().mockReturnValue('linux'),
  homedir: vi.fn().mockReturnValue('/home/test'),

  // daemon — fs
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),

  // daemon — @clack/prompts
  clackLog: {
    success: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },

  // codex — spawn (leaf dep of launchManagedCodex)
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

// ============================================================
// Module mocks (top-level, hoisted by vitest)
// ============================================================

vi.mock('../../src/global-config.ts', () => ({
  getConfigValue: mocks.getConfigValue,
  setConfigValue: mocks.setConfigValue,
  deleteConfigValue: mocks.deleteConfigValue,
  getAllConfig: mocks.getAllConfig,
  getConfigPath: mocks.getConfigPath,
  validateConfigValue: mocks.validateConfigValue,
  maskSensitive: mocks.maskSensitive,
  SENSITIVE_KEYS: mocks.SENSITIVE_KEYS,
  VALID_KEYS: mocks.VALID_KEYS,
}));

vi.mock('../../src/project-registry.ts', () => ({
  loadRegistry: mocks.loadRegistry,
  registerProject: mocks.registerProject,
  getAllRegisteredProjects: mocks.getAllRegisteredProjects,
  getProjectByPath: mocks.getProjectByPath,
  renameProject: mocks.renameProject,
  removeProject: mocks.removeProject,
  bindProjectCategory: vi.fn().mockResolvedValue(undefined),
  unbindProjectCategory: mocks.unbindProjectCategory,
}));

vi.mock('../../src/discord/attachment-inbox.ts', () => ({
  fetchRegisteredAttachments: mocks.fetchRegisteredAttachments,
}));

vi.mock('node:child_process', () => ({
  execSync: mocks.execSync,
  execFile: mocks.execFile,
  spawn: mocks.spawn,
}));

vi.mock('node:os', () => ({
  platform: mocks.platform,
  homedir: mocks.homedir,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  unlinkSync: mocks.unlinkSync,
}));

vi.mock('@clack/prompts', () => ({
  log: mocks.clackLog,
}));

// ============================================================
// Helpers
// ============================================================

async function captureConsole(fn: () => Promise<void>) {
  const logs: string[] = [];
  const errors: string[] = [];

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '));
  });

  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return { logs, errors };
}

// ============================================================
// Tests
// ============================================================

describe('CLI Commands Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRegistry.mockResolvedValue(undefined);
    mocks.validateConfigValue.mockReturnValue(null);
    mocks.maskSensitive.mockImplementation((_k: string, v: string) => v);
    mocks.existsSync.mockReturnValue(true);
    mocks.platform.mockReturnValue('linux');
    mocks.homedir.mockReturnValue('/home/test');
    // Defaults (opt-in per test)
    mocks.getProjectByPath.mockReturnValue(undefined);
    mocks.getAllConfig.mockReturnValue({});
    mocks.getConfigPath.mockReturnValue('/test/config.json');
    mocks.spawn.mockReturnValue({ on: vi.fn() });
    mocks.getConfigValue.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- config list ---
  describe('config list', () => {
    it('displays all configuration entries', async () => {
      mocks.getAllConfig.mockReturnValue({
        DISCORD_TOKEN: 'xoxb-abc',
        DEFAULT_PROVIDER: 'claude',
      });

      const { handleConfig } = await import('../../src/config-cli.ts');
      const { logs } = await captureConsole(() => handleConfig(['list']));

      expect(mocks.getAllConfig).toHaveBeenCalled();
      expect(logs.some((l) => l.includes('DISCORD_TOKEN'))).toBe(true);
      expect(logs.some((l) => l.includes('DEFAULT_PROVIDER'))).toBe(true);
    });

    it('shows message when no config is set', async () => {
      mocks.getAllConfig.mockReturnValue({});

      const { handleConfig } = await import('../../src/config-cli.ts');
      const { logs } = await captureConsole(() => handleConfig(['list']));

      expect(logs.some((l) => l.includes('no configuration set'))).toBe(true);
    });
  });

  // --- config path ---
  describe('config path', () => {
    it('displays the configuration file path', async () => {
      mocks.getConfigPath.mockReturnValue('/home/test/.config/workspacecord/config.json');

      const { handleConfig } = await import('../../src/config-cli.ts');
      const { logs } = await captureConsole(() => handleConfig(['path']));

      expect(mocks.getConfigPath).toHaveBeenCalled();
      expect(logs[0]).toBe('/home/test/.config/workspacecord/config.json');
    });
  });

  // --- config set ---
  describe('config set', () => {
    it('sets a configuration value', async () => {
      const { handleConfig } = await import('../../src/config-cli.ts');
      const { logs } = await captureConsole(() => handleConfig(['set', 'DISCORD_TOKEN', 'xoxb-123']));

      expect(mocks.setConfigValue).toHaveBeenCalledWith('DISCORD_TOKEN', 'xoxb-123');
      expect(logs.some((l) => l.includes('DISCORD_TOKEN'))).toBe(true);
    });
  });

  // --- config unset ---
  describe('config unset', () => {
    it('removes a configuration value', async () => {
      const { handleConfig } = await import('../../src/config-cli.ts');
      const { logs } = await captureConsole(() => handleConfig(['unset', 'DISCORD_TOKEN']));

      expect(mocks.deleteConfigValue).toHaveBeenCalledWith('DISCORD_TOKEN');
      expect(logs.some((l) => l.includes('removed'))).toBe(true);
    });
  });

  // --- project init ---
  describe('project init', () => {
    it('registers the current directory as a project', async () => {
      const expectedPath = process.cwd();
      const expectedName = expectedPath.split('/').pop() || 'workspacecord';
      mocks.registerProject.mockResolvedValue({
        name: expectedName,
        path: expectedPath,
        id: 'uuid-1',
        skills: {},
        mcpServers: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const { handleProject } = await import('../../src/project-cli.ts');
      const { logs } = await captureConsole(() => handleProject(['init']));

      expect(mocks.loadRegistry).toHaveBeenCalled();
      expect(mocks.registerProject).toHaveBeenCalledWith(
        expectedName,
        expectedPath,
      );
      expect(logs.some((l) => l.includes('mounted'))).toBe(true);
    });

    it('accepts --name flag for custom project name', async () => {
      const expectedPath = process.cwd();
      mocks.registerProject.mockResolvedValue({
        name: 'custom-name',
        path: expectedPath,
        id: 'uuid-2',
        skills: {},
        mcpServers: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const { handleProject } = await import('../../src/project-cli.ts');
      const { logs } = await captureConsole(() => handleProject(['init', '--name', 'custom-name']));

      expect(mocks.registerProject).toHaveBeenCalledWith(
        'custom-name',
        expectedPath,
      );
      expect(logs.some((l) => l.includes('custom-name'))).toBe(true);
    });
  });

  // --- project list ---
  describe('project list', () => {
    it('lists all mounted projects', async () => {
      mocks.getAllRegisteredProjects.mockReturnValue([
        {
          name: 'project-a', path: '/home/a',
          discordCategoryId: 'cat-1', discordCategoryName: 'Category A',
          skills: {}, mcpServers: [], id: '1', createdAt: 0, updatedAt: 0,
        },
        {
          name: 'project-b', path: '/home/b',
          skills: {}, mcpServers: [], id: '2', createdAt: 0, updatedAt: 0,
        },
      ]);

      const { handleProject } = await import('../../src/project-cli.ts');
      const { logs } = await captureConsole(() => handleProject(['list']));

      expect(mocks.getAllRegisteredProjects).toHaveBeenCalled();
      expect(logs.some((l) => l.includes('project-a'))).toBe(true);
      expect(logs.some((l) => l.includes('project-b'))).toBe(true);
      expect(logs.some((l) => l.includes('discord:pending'))).toBe(true);
    });

    it('shows message when no projects are mounted', async () => {
      mocks.getAllRegisteredProjects.mockReturnValue([]);

      const { handleProject } = await import('../../src/project-cli.ts');
      const { logs } = await captureConsole(() => handleProject(['list']));

      expect(logs.some((l) => l.includes('No projects mounted'))).toBe(true);
    });
  });

  // --- project info ---
  describe('project info', () => {
    it('exits when directory is not mounted', async () => {
      // Must run before any test that sets getProjectByPath to a truthy value.
      // beforeEach already sets it to undefined.

      // Mock process.exit to throw so the function actually stops executing.
      // The default mock of returning undefined doesn't stop the control flow.
      const exitMock = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit(1) called');
      });
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { handleProject } = await import('../../src/project-cli.ts');

      await expect(handleProject(['info'])).rejects.toThrow('process.exit(1) called');
      expect(exitMock).toHaveBeenCalledWith(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'Current directory is not mounted as a workspacecord project.',
      );

      exitMock.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('displays current project details', async () => {
      mocks.getProjectByPath.mockReturnValue({
        name: 'current-project',
        path: process.cwd(),
        discordCategoryId: 'cat-123',
        discordCategoryName: 'My Category',
        historyChannelId: 'ch-1',
        skills: {},
        mcpServers: [],
        id: '3',
        createdAt: 0,
        updatedAt: 0,
      });

      const { handleProject } = await import('../../src/project-cli.ts');
      const { logs } = await captureConsole(() => handleProject(['info']));

      expect(mocks.getProjectByPath).toHaveBeenCalled();
      expect(logs.some((l) => l.includes('current-project'))).toBe(true);
      expect(logs.some((l) => l.includes('cat-123'))).toBe(true);
    });
  });

  // --- daemon status ---
  describe('daemon status', () => {
    it('checks daemon status on Linux', async () => {
      mocks.execSync.mockImplementation((cmd: string) => {
        if (cmd.includes('is-active')) return 'active\n';
        if (cmd.includes('status')) return '  Active: active (running)\n';
        return '';
      });

      const { handleDaemon } = await import('../../src/daemon.ts');
      await captureConsole(() => handleDaemon('status'));

      expect(mocks.execSync).toHaveBeenCalledWith(
        expect.stringContaining('systemctl --user is-active'),
        expect.any(Object),
      );
      expect(mocks.clackLog.success).toHaveBeenCalledWith('Running');
    });
  });

  // --- attachment fetch ---
  describe('attachment fetch', () => {
    it('fetches a single attachment and outputs JSON', async () => {
      mocks.fetchRegisteredAttachments.mockResolvedValue([
        {
          attachmentId: 'att-1', name: 'screenshot.png',
          contentType: 'image/png', sizeBytes: 4096, path: '/tmp/screenshot.png',
        },
      ]);

      const { handleAttachment } = await import('../../src/attachment-cli.ts');
      const { logs } = await captureConsole(() => handleAttachment([
        'fetch',
        '--session', 'sess-1',
        '--message', 'msg-1',
        '--attachment', 'att-1',
      ]));

      expect(mocks.fetchRegisteredAttachments).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        messageId: 'msg-1',
        attachmentId: 'att-1',
        all: false,
        currentSessionId: 'sess-1',
      });
      expect(logs.some((l) => l.includes('screenshot.png'))).toBe(true);
    });

    it('fetches all attachments with --all flag', async () => {
      mocks.fetchRegisteredAttachments.mockResolvedValue([]);

      const { handleAttachment } = await import('../../src/attachment-cli.ts');
      await captureConsole(() => handleAttachment([
        'fetch',
        '--session', 'sess-1',
        '--message', 'msg-1',
        '--all',
      ]));

      expect(mocks.fetchRegisteredAttachments).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        messageId: 'msg-1',
        attachmentId: undefined,
        all: true,
        currentSessionId: 'sess-1',
      });
    });
  });

  // --- codex command ---
  describe('codex', () => {
    it('launches codex with no arguments', async () => {
      const { handleCodexCommand } = await import('../../src/cli/codex-launcher.ts');
      await handleCodexCommand([]);

      expect(mocks.spawn).toHaveBeenCalledWith(
        'codex',
        [],
        expect.objectContaining({
          env: expect.objectContaining({
            workspacecord_MANAGED: '1',
          }),
        }),
      );
    });

    it('passes --model flag through arg parsing', async () => {
      mocks.spawn.mockClear();

      const { handleCodexCommand } = await import('../../src/cli/codex-launcher.ts');
      await handleCodexCommand(['--model', 'gpt-4o']);

      const spawnArgs = mocks.spawn.mock.calls[0];
      expect(spawnArgs[1]).toContain('--model');
      expect(spawnArgs[1]).toContain('gpt-4o');
    });

    it('passes --cwd flag through arg parsing', async () => {
      mocks.spawn.mockClear();

      const { handleCodexCommand } = await import('../../src/cli/codex-launcher.ts');
      await handleCodexCommand(['--cwd', '/my/project']);

      const spawnArgs = mocks.spawn.mock.calls[0];
      expect(spawnArgs[2].cwd).toBe('/my/project');
      expect(spawnArgs[2].env.workspacecord_SESSION_CWD).toBe('/my/project');
    });

    it('passes multiple flags through arg parsing', async () => {
      mocks.spawn.mockClear();

      const { handleCodexCommand } = await import('../../src/cli/codex-launcher.ts');
      await handleCodexCommand([
        '--model', 'gpt-4',
        '--sandbox-mode', 'workspace-write',
        '--approval-policy', 'on-request',
      ]);

      const spawnArgs = mocks.spawn.mock.calls[0];
      const codexArgs = spawnArgs[1];
      expect(codexArgs).toContain('--model');
      expect(codexArgs).toContain('gpt-4');
      expect(codexArgs).toContain('--sandbox-mode');
      expect(codexArgs).toContain('workspace-write');
      expect(codexArgs).toContain('--approval-policy');
      expect(codexArgs).toContain('on-request');
    });
  });
});
