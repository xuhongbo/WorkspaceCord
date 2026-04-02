const command = process.argv[2];

switch (command) {
  case 'setup': {
    // Alias: workspacecord setup → workspacecord config setup
    const { handleConfig } = await import('./config-cli.ts');
    await handleConfig(['setup']);
    break;
  }
  case 'config': {
    const { handleConfig } = await import('./config-cli.ts');
    await handleConfig(process.argv.slice(3));
    break;
  }
  case 'start':
  case undefined: {
    const { startBot } = await import('./bot.ts');
    console.log('workspacecord starting...');
    await startBot();
    break;
  }
  case 'project': {
    const { handleProject } = await import('./project-cli.ts');
    await handleProject(process.argv.slice(3));
    break;
  }
  case 'attachment': {
    const { handleAttachment } = await import('./attachment-cli.ts');
    await handleAttachment(process.argv.slice(3));
    break;
  }
  case 'daemon': {
    const { handleDaemon } = await import('./daemon.ts');
    await handleDaemon(process.argv[3]);
    break;
  }
  case 'codex': {
    const { handleCodexCommand } = await import('./cli/codex-launcher.ts');
    await handleCodexCommand(process.argv.slice(3));
    break;
  }
  case 'help':
  case '--help':
  case '-h': {
    console.log(`
  \x1b[1mworkspacecord\x1b[0m — Discord bot for multi-agent coding sessions

  \x1b[1mUsage:\x1b[0m
    workspacecord                     Start the bot
    workspacecord config setup        Interactive configuration wizard
    workspacecord config get <key>    Read a config value
    workspacecord config set <k> <v>  Write a config value
    workspacecord config list         List all config values
    workspacecord config path         Show config file path
    workspacecord project <subcommand> Manage mounted projects
    workspacecord attachment fetch    Download registered Discord attachments
    workspacecord daemon              Manage background service (install/uninstall/status)
    workspacecord codex [options]     Launch managed Codex session with remote approval
    workspacecord help                Show this help message

  \x1b[1mQuick start:\x1b[0m
    1. workspacecord config setup      Configure Discord app, token, permissions
    2. workspacecord project init      Mount a local project
    3. workspacecord                   Start the bot
    4. /project setup project:<name> Bind a Discord category to the mounted project
    5. /agent spawn label:<task>    Create an agent session

  \x1b[2mhttps://github.com/xuhongbo/WorkspaceCord\x1b[0m
`);
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run \x1b[36mworkspacecord help\x1b[0m for usage.');
    process.exit(1);
}
