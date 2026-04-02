import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_REQUIRED_HOOKS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
];

const originalNodeEnv = process.env.NODE_ENV;
const originalCwd = process.cwd();

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeProjectHookSetup(projectDir: string): void {
  const hookDir = path.join(projectDir, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hookScriptPath = path.join(hookDir, 'workspacecord-hook.cjs');
  fs.writeFileSync(hookScriptPath, '#!/usr/bin/env node\n', 'utf8');
  fs.chmodSync(hookScriptPath, 0o755);

  const hooks = Object.fromEntries(
    PROJECT_REQUIRED_HOOKS.map((hook) => [
      hook,
      [
        {
          hooks: [
            {
              type: 'command',
              command: `node "$CLAUDE_PROJECT_DIR"/.claude/hooks/workspacecord-hook.cjs ${hook}`,
            },
          ],
        },
      ],
    ]),
  );

  fs.writeFileSync(
    path.join(projectDir, '.claude', 'settings.json'),
    JSON.stringify({ hooks }, null, 2),
    'utf8',
  );
}

async function importHookHealthModule(mockHomeDir: string) {
  vi.resetModules();
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
      ...actual,
      homedir: () => mockHomeDir,
    };
  });
  return import('../src/hook-health-check.ts');
}

describe('hook health check', () => {
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.chdir(originalCwd);
    vi.doUnmock('node:os');
    vi.resetModules();
  });

  it('开发环境下接受项目内 .claude 钩子配置', async () => {
    const homeDir = makeTempDir('workspacecord-hook-home-');
    const projectDir = makeTempDir('workspacecord-hook-project-');
    writeProjectHookSetup(projectDir);
    process.chdir(projectDir);
    process.env.NODE_ENV = 'development';

    const { checkHookHealth } = await importHookHealthModule(homeDir);
    const status = checkHookHealth();

    expect(status.isHealthy).toBe(true);
    expect(status.issues).toEqual([]);
  });

  it('非开发环境下仍要求全局 ~/.claude 钩子安装', async () => {
    const homeDir = makeTempDir('workspacecord-hook-home-');
    const projectDir = makeTempDir('workspacecord-hook-project-');
    writeProjectHookSetup(projectDir);
    process.chdir(projectDir);
    process.env.NODE_ENV = 'production';

    const { checkHookHealth } = await importHookHealthModule(homeDir);
    const status = checkHookHealth();

    expect(status.isHealthy).toBe(false);
    expect(status.issues).toContain('钩子脚本不存在: ~/.claude/hooks/workspacecord-hook.cjs');
  });

  it('start 脚本会注入开发环境变量', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(originalCwd, 'package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.start).toContain('NODE_ENV=development');
  });
});
