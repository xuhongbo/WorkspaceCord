import * as p from '@clack/prompts';
import { existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

const LABEL = 'com.workspacecord';
const SERVICE_NAME = 'workspacecord';

function getMacPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function getLinuxServicePath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function getNodePath(): string {
  return process.execPath;
}

function getCliPath(): string {
  // When installed globally, find the actual cli.js path
  try {
    const result = execSync('which workspacecord', { encoding: 'utf-8' }).trim();
    if (result) {
      // pnpm creates a shell wrapper — parse it to find the real JS file
      try {
        const wrapper = readFileSync(result, 'utf-8');
        // Match patterns like: exec node "$basedir/../../path/to/cli.js"
        const match = wrapper.match(
          /exec\s+(?:node|"\$basedir\/node")\s+"?\$basedir\/([^"$\s]+cli\.js)"?/,
        );
        if (match) {
          // Resolve relative paths against the wrapper's directory
          const wrapperDir = execSync(`dirname "${result}"`, { encoding: 'utf-8' }).trim();
          const resolved = resolve(wrapperDir, match[1]);
          if (existsSync(resolved)) return resolved;
        }
      } catch {
        /* not a shell wrapper */
      }

      // Try resolving as symlink
      const realPath = execSync(
        `readlink -f "${result}" 2>/dev/null || realpath "${result}" 2>/dev/null || echo "${result}"`,
        { encoding: 'utf-8' },
      ).trim();
      // If it resolved to a .js file, use it directly
      if (realPath.endsWith('.js') && existsSync(realPath)) return realPath;
    }
  } catch {
    /* ignore */
  }

  // Fallback: use the dist/cli.js relative to this file
  return resolve(import.meta.dirname!, '..', 'dist', 'cli.js');
}

function generateMacPlist(workDir: string, logDir: string): string {
  const nodePath = getNodePath();
  const cliPath = getCliPath();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>--watch</string>
        <string>${cliPath}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${workDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
        <string>${join(logDir, 'workspacecord.log')}</string>
    <key>StandardErrorPath</key>
        <string>${join(logDir, 'workspacecord.error.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>`;
}

function generateSystemdUnit(workDir: string): string {
  const nodePath = getNodePath();
  const cliPath = getCliPath();

  return `[Unit]
Description=workspacecord - Discord AI agent bot
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} --watch ${cliPath}
WorkingDirectory=${workDir}
Restart=on-abnormal
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

async function install(): Promise<void> {
  const workDir = join(homedir(), '.workspacecord');
  const isMac = platform() === 'darwin';

  if (isMac) {
    const plistPath = getMacPlistPath();
    const logDir = workDir;

    // Unload existing if present
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
      } catch {
        /* ignore */
      }
    }

    const plist = generateMacPlist(workDir, logDir);
    writeFileSync(plistPath, plist);
    execSync(`launchctl load "${plistPath}"`);

    p.log.success('LaunchAgent installed and started.');
    p.log.info(`Plist:  ${plistPath}`);
    p.log.info(`Logs:   ${join(logDir, 'workspacecord.log')}`);
    p.log.info(`Errors: ${join(logDir, 'workspacecord.error.log')}`);
  } else {
    const servicePath = getLinuxServicePath();
    const serviceDir = resolve(servicePath, '..');

    if (!existsSync(serviceDir)) {
      execSync(`mkdir -p "${serviceDir}"`);
    }

    const unit = generateSystemdUnit(workDir);
    writeFileSync(servicePath, unit);
    execSync('systemctl --user daemon-reload');
    execSync(`systemctl --user enable ${SERVICE_NAME}`);
    execSync(`systemctl --user start ${SERVICE_NAME}`);

    p.log.success('systemd user service installed and started.');
    p.log.info(`Unit: ${servicePath}`);
    p.log.info(`Logs: journalctl --user -u ${SERVICE_NAME} -f`);
  }
}

async function uninstall(): Promise<void> {
  const isMac = platform() === 'darwin';

  if (isMac) {
    const plistPath = getMacPlistPath();
    if (!existsSync(plistPath)) {
      p.log.warn('No LaunchAgent found. Nothing to uninstall.');
      return;
    }
    try {
      execSync(`launchctl unload "${plistPath}"`);
    } catch {
      /* ignore */
    }
    unlinkSync(plistPath);
    p.log.success('LaunchAgent uninstalled.');
  } else {
    const servicePath = getLinuxServicePath();
    if (!existsSync(servicePath)) {
      p.log.warn('No systemd service found. Nothing to uninstall.');
      return;
    }
    try {
      execSync(`systemctl --user stop ${SERVICE_NAME}`);
      execSync(`systemctl --user disable ${SERVICE_NAME}`);
    } catch {
      /* ignore */
    }
    unlinkSync(servicePath);
    execSync('systemctl --user daemon-reload');
    p.log.success('systemd user service uninstalled.');
  }
}

async function status(): Promise<void> {
  const isMac = platform() === 'darwin';

  if (isMac) {
    const plistPath = getMacPlistPath();
    if (!existsSync(plistPath)) {
      p.log.warn('No LaunchAgent installed.');
      return;
    }
    try {
      const output = execSync(`launchctl list | grep ${LABEL}`, { encoding: 'utf-8' }).trim();
      if (output) {
        const parts = output.split('\t');
        const pid = parts[0];
        const exitCode = parts[1];
        if (pid && pid !== '-') {
          p.log.success(`Running (PID ${pid})`);
        } else {
          p.log.warn(`Not running (last exit code: ${exitCode})`);
        }
      } else {
        p.log.warn('Installed but not loaded.');
      }
    } catch {
      p.log.warn('Installed but not loaded.');
    }

    // Show working directory from plist
    try {
      const plist = readFileSync(plistPath, 'utf-8');
      const match = plist.match(/<key>WorkingDirectory<\/key>\s*<string>(.+?)<\/string>/);
      if (match) p.log.info(`Directory: ${match[1]}`);
    } catch {
      /* ignore */
    }
  } else {
    try {
      const output = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
        encoding: 'utf-8',
      }).trim();
      if (output === 'active') {
        p.log.success('Running');
      } else {
        p.log.warn(`Status: ${output}`);
      }
      const statusOutput = execSync(`systemctl --user status ${SERVICE_NAME} --no-pager -l`, {
        encoding: 'utf-8',
      });
      console.log(statusOutput);
    } catch (err: unknown) {
      const servicePath = getLinuxServicePath();
      if (existsSync(servicePath)) {
        p.log.warn('Installed but not running.');
      } else {
        p.log.warn('No systemd service installed.');
      }
    }
  }
}

export async function handleDaemon(subcommand: string | undefined): Promise<void> {
  switch (subcommand) {
    case 'install':
      await install();
      break;
    case 'uninstall':
    case 'remove':
      await uninstall();
      break;
    case 'status':
      await status();
      break;
    default:
      console.log(`
  \x1b[1mworkspacecord daemon\x1b[0m — manage background service

  \x1b[1mUsage:\x1b[0m
    workspacecord daemon install     Install and start as background service
    workspacecord daemon uninstall   Stop and remove the background service
    workspacecord daemon status      Check if the service is running

  The service auto-starts on boot and restarts on crash.
  Run \x1b[36mworkspacecord config setup\x1b[0m first to configure the bot.
`);
  }
}
