import * as p from '@clack/prompts';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getConfigValue, setConfigValue } from '@workspacecord/core';

function color(text: string, code: number): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const dim = (t: string) => color(t, 2);
const cyan = (t: string) => color(t, 36);
const green = (t: string) => color(t, 32);
const yellow = (t: string) => color(t, 33);
const bold = (t: string) => color(t, 1);

function cancelled(): never {
  p.cancel('Setup cancelled.');
  process.exit(0);
}

export async function runSetup(): Promise<void> {
  const isReconfigure = !!getConfigValue('DISCORD_TOKEN');

  p.intro(bold(' workspacecord setup '));

  if (isReconfigure) {
    p.note(
      'Existing configuration detected.\nYour current values will be shown as defaults.',
      'Reconfiguring',
    );
  }

  // ─── Step 1: Discord App Creation Guide ───

  const hasApp = await p.confirm({
    message: 'Do you already have a Discord Application created?',
    initialValue: isReconfigure,
  });
  if (p.isCancel(hasApp)) cancelled();

  if (!hasApp) {
    p.note(
      [
        `${bold('1.')} Go to ${cyan('https://discord.com/developers/applications')}`,
        `${bold('2.')} Click ${green('"New Application"')} and give it a name`,
        `${bold('3.')} Go to the ${bold('Bot')} tab on the left`,
        `${bold('4.')} Click ${green('"Reset Token"')} and copy the token`,
        `${bold('5.')} Under ${bold('Privileged Gateway Intents')}, enable:`,
        `   ${yellow('*')} Message Content Intent`,
        `   ${yellow('*')} Server Members Intent`,
        `${bold('6.')} Go to the ${bold('General Information')} tab`,
        `${bold('7.')} Copy the ${bold('Application ID')} (this is your Client ID)`,
        '',
        dim("Keep this tab open — you'll need the token and ID next."),
      ].join('\n'),
      'Create a Discord App',
    );

    await p.confirm({
      message: 'Ready to continue?',
      initialValue: true,
    });
  }

  // ─── Step 2: Bot Token ───

  const token = await p.password({
    message: 'Paste your Discord Bot Token:',
    validate(value) {
      if (!value || !value.trim()) return 'Token is required';
      if (value.length < 50) return "That doesn't look like a valid bot token";
    },
  });
  if (p.isCancel(token)) cancelled();

  // ─── Step 3: Client ID ───

  const clientId = await p.text({
    message: 'Paste your Application (Client) ID:',
    placeholder: getConfigValue('DISCORD_CLIENT_ID') || '123456789012345678',
    initialValue: getConfigValue('DISCORD_CLIENT_ID'),
    validate(value) {
      if (!value || !value.trim()) return 'Client ID is required';
      if (!/^\d{17,20}$/.test(value.trim())) return 'Client ID should be a 17-20 digit number';
    },
  });
  if (p.isCancel(clientId)) cancelled();

  // ─── Step 4: Guild ID ───

  const guildSetup = await p.confirm({
    message:
      'Do you want to register commands to a specific server? (instant, recommended for testing)',
    initialValue: !!getConfigValue('DISCORD_GUILD_ID'),
  });
  if (p.isCancel(guildSetup)) cancelled();

  let guildId = '';
  if (guildSetup) {
    if (!hasApp) {
      p.note(
        [
          `${bold('1.')} Open Discord and go to ${bold('User Settings > Advanced')}`,
          `${bold('2.')} Enable ${green('"Developer Mode"')}`,
          `${bold('3.')} Right-click your server name and click ${green('"Copy Server ID"')}`,
        ].join('\n'),
        'How to get your Server ID',
      );
    }

    const guildInput = await p.text({
      message: 'Paste your Server (Guild) ID:',
      placeholder: getConfigValue('DISCORD_GUILD_ID') || '123456789012345678',
      initialValue: getConfigValue('DISCORD_GUILD_ID'),
      validate(value) {
        if (!value || !value.trim()) return 'Guild ID is required';
        if (!/^\d{17,20}$/.test(value.trim())) return 'Guild ID should be a 17-20 digit number';
      },
    });
    if (p.isCancel(guildInput)) cancelled();
    guildId = guildInput.trim();
  }

  // ─── Step 5: Allowed Users ───

  const existingAllowAllUsers = getConfigValue('ALLOW_ALL_USERS') === 'true';
  const authMode = await p.select({
    message: 'Who should be allowed to use the bot?',
    options: [
      {
        value: 'whitelist',
        label: 'Specific users (recommended)',
        hint: 'comma-separated Discord user IDs',
      },
      {
        value: 'all',
        label: 'Everyone in the server',
        hint: 'not recommended for shared servers',
      },
    ],
    initialValue: existingAllowAllUsers ? 'all' : 'whitelist',
  });
  if (p.isCancel(authMode)) cancelled();

  let allowedUsers = '';
  if (authMode === 'whitelist') {
    if (!hasApp && !getConfigValue('ALLOWED_USERS')) {
      p.note(
        [
          `${bold('1.')} Open Discord with ${bold('Developer Mode')} enabled`,
          `${bold('2.')} Click on your profile picture or username`,
          `${bold('3.')} Click ${green('"Copy User ID"')}`,
          '',
          dim('You can add more users later with: workspacecord config set ALLOWED_USERS <ids>'),
        ].join('\n'),
        'How to get your User ID',
      );
    }

    const usersInput = await p.text({
      message: 'Enter allowed Discord User IDs (comma-separated):',
      placeholder: '123456789012345678',
      initialValue: getConfigValue('ALLOWED_USERS'),
      validate(value) {
        if (!value || !value.trim()) return 'At least one user ID is required';
        const ids = value.split(',').map((s) => s.trim());
        for (const id of ids) {
          if (!/^\d{17,20}$/.test(id)) return `Invalid user ID: ${id}`;
        }
      },
    });
    if (p.isCancel(usersInput)) cancelled();
    allowedUsers = usersInput.trim();
  }

  // ─── Step 6: Save config ───

  const s = p.spinner();
  s.start('Saving configuration...');

  setConfigValue('DISCORD_TOKEN', token.trim());
  setConfigValue('DISCORD_CLIENT_ID', clientId.trim());
  if (guildId) setConfigValue('DISCORD_GUILD_ID', guildId);
  if (authMode === 'all') {
    setConfigValue('ALLOW_ALL_USERS', 'true');
  } else {
    setConfigValue('ALLOWED_USERS', allowedUsers);
    setConfigValue('ALLOW_ALL_USERS', 'false');
  }

  s.stop('Configuration saved to global store');

  // ─── Step 7: Generate Invite URL ───

  const permissions = 8; // Administrator
  const scopes = 'bot%20applications.commands';
  const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId.trim()}&permissions=${permissions}&scope=${scopes}`;

  p.note(
    [
      bold('Add the bot to your server:'),
      '',
      cyan(inviteUrl),
      '',
      dim('Open this URL in your browser and select your server.'),
    ].join('\n'),
    'Invite Link',
  );

  const openBrowser = await p.confirm({
    message: 'Open the invite URL in your browser?',
    initialValue: true,
  });
  if (p.isCancel(openBrowser)) cancelled();

  if (openBrowser) {
    try {
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      execSync(`${cmd} "${inviteUrl}"`, { stdio: 'ignore' });
    } catch {
      p.log.warn('Could not open browser. Please open the URL manually.');
    }
  }

  // ─── Step 8: Verify Connection ───

  const verify = await p.confirm({
    message: 'Test the bot connection now?',
    initialValue: true,
  });
  if (p.isCancel(verify)) cancelled();

  if (verify) {
    s.start('Connecting to Discord...');
    try {
      const { Client, GatewayIntentBits } = await import('discord.js');
      const client = new Client({
        intents: [GatewayIntentBits.Guilds],
      });

      const loginResult = await Promise.race([
        new Promise<string>((res, rej) => {
          client.once('ready', () => {
            const name = client.user?.tag || 'Unknown';
            const guildCount = client.guilds.cache.size;
            client.destroy();
            res(`${name} — connected to ${guildCount} server(s)`);
          });
          client.login(token.trim()).catch(rej);
        }),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error('Connection timed out after 15s')), 15000),
        ),
      ]);

      s.stop(green(`Connected: ${loginResult}`));
    } catch (err: unknown) {
      s.stop(`Connection failed: ${(err as Error).message}`);
      p.log.warn('Double-check your bot token and try again.');
      p.log.info(`You can re-run setup with: ${cyan('workspacecord config setup')}`);
    }
  }

  // ─── Step 9: Install Daemon ───

  const installDaemon = await p.confirm({
    message: 'Start workspacecord as a background service? (auto-starts on boot, restarts on crash)',
    initialValue: true,
  });
  if (p.isCancel(installDaemon)) cancelled();

  if (installDaemon) {
    s.start('Installing background service...');
    try {
      const { handleDaemon } = await import('./daemon.ts');
      await handleDaemon('install');
      s.stop(green('Background service installed and running'));
    } catch (err: unknown) {
      s.stop(`Service install failed: ${(err as Error).message}`);
      p.log.warn(`You can install it later with: ${cyan('workspacecord daemon install')}`);
    }
  }

  // ─── Done ───

  const nextSteps = [
    `Use ${bold('/project setup project:<name>')} and ${bold('/agent spawn label:<task>')} in Discord to create your first session.`,
  ];

  if (!installDaemon) {
    nextSteps.unshift(`Start the bot:  ${cyan('workspacecord')}`, '');
  } else {
    nextSteps.unshift(
      `The bot is running in the background.`,
      `Check status:   ${cyan('workspacecord daemon status')}`,
      `View logs:      ${cyan('tail -f ~/.workspacecord/workspacecord.log')}`,
      '',
    );
  }

  nextSteps.push('', `Re-run setup:   ${cyan('workspacecord config setup')}`);
  nextSteps.push(`View config:    ${cyan('workspacecord config list')}`);

  p.note(nextSteps.join('\n'), 'Next Steps');

  p.outro(green('Setup complete!'));
}
