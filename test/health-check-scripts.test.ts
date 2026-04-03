import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repoRoot = process.cwd();
const setupScriptPath = join(repoRoot, 'scripts', 'setup-health-check-cron.sh');
const healthScriptPath = join(repoRoot, 'scripts', 'health-check.sh');

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe('健康检查脚本', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('安装脚本应写入当前仓库下的健康检查脚本路径', () => {
    const home = makeTempDir('workspacecord-health-home-');
    const binDir = makeTempDir('workspacecord-health-bin-');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });

    writeExecutable(
      join(binDir, 'launchctl'),
      `#!/bin/bash
exit 0
`,
    );

    const result = spawnSync('bash', [setupScriptPath], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);

    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.workspacecord.health-check.plist');
    expect(existsSync(plistPath)).toBe(true);

    const plist = readFileSync(plistPath, 'utf8');
    expect(plist).toContain(healthScriptPath);
    expect(plist).not.toContain('/Users/ld/Documents/github/workspacecord/scripts/health-check.sh');
  });

  it('主脚本应兼容当前命令名并基于当前仓库完成全量恢复', () => {
    const home = makeTempDir('workspacecord-health-main-home-');
    const binDir = makeTempDir('workspacecord-health-main-bin-');
    mkdirSync(join(home, '.workspacecord'), { recursive: true });

    writeExecutable(
      join(binDir, 'launchctl'),
      `#!/bin/bash
state_file="$HOME/daemon.state"
case "$1" in
  list)
    if [ -f "$state_file" ]; then
      printf '123\\t0\\tcom.workspacecord\\n'
    fi
    ;;
  load|unload)
    ;;
esac
exit 0
`,
    );

    writeExecutable(
      join(binDir, 'threadcord'),
      `#!/bin/bash
log_file="$HOME/cli.log"
count_file="$HOME/install-count"
state_file="$HOME/daemon.state"
echo "$@" >> "$log_file"

if [ "$1" = "daemon" ] && [ "$2" = "uninstall" ]; then
  rm -f "$state_file"
  exit 0
fi

if [ "$1" = "daemon" ] && [ "$2" = "install" ]; then
  count=0
  if [ -f "$count_file" ]; then
    count=$(cat "$count_file")
  fi
  count=$((count + 1))
  echo "$count" > "$count_file"
  if [ "$count" -ge 2 ]; then
    echo running > "$state_file"
    mkdir -p "$HOME/.workspacecord"
    echo 1 > "$HOME/.workspacecord/bot.lock"
  fi
  exit 0
fi

exit 0
`,
    );

    writeExecutable(
      join(binDir, 'pnpm'),
      `#!/bin/bash
echo "$PWD :: $@" >> "$HOME/pnpm.log"
if [ "$1" = "pack" ]; then
  touch "$PWD/threadcord-test.tgz"
fi
exit 0
`,
    );

    writeExecutable(
      join(binDir, 'sleep'),
      `#!/bin/bash
exit 0
`,
    );

    const result = spawnSync('bash', [healthScriptPath], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);

    const cliLog = readFileSync(join(home, 'cli.log'), 'utf8');
    expect(cliLog).toContain('daemon install');
    expect(cliLog).toContain('daemon uninstall');

    const pnpmLog = readFileSync(join(home, 'pnpm.log'), 'utf8');
    expect(pnpmLog).toContain(`${repoRoot} :: build`);
    expect(pnpmLog).toContain(`${repoRoot} :: pack`);
    expect(pnpmLog).toContain(`${repoRoot} :: install -g ${repoRoot}/threadcord-test.tgz`);

    const healthLog = readFileSync(join(home, '.workspacecord', 'health-check.log'), 'utf8');
    expect(healthLog).toContain('Full deployment completed successfully');
    expect(healthLog).not.toContain('/Users/ld/Documents/github/workspacecord');
  });
});
