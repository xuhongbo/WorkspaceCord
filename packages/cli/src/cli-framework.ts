import cac from 'cac';
import { startBot } from '@workspacecord/bot';

export { startBot };

export async function runCli(): Promise<void> {
  const cli = cac('workspacecord');

  // Default: start bot
  cli.command('', 'Start the bot')
    .action(async () => {
      console.log('workspacecord starting...');
      await startBot();
    });

  // Config subcommands
  cli.command('config [action] [key] [value]', 'Manage configuration')
    .action(async (action: string | undefined, key: string | undefined, value: string | undefined) => {
      const { handleConfig } = await import('./config-cli.ts');
      const args = [action || 'list'].filter(Boolean) as string[];
      if (key) args.push(key);
      if (value) args.push(value);
      if (args.length === 0) args.push('list');
      await handleConfig(args);
    });

  // Project subcommands
  cli.command('project [action] [...args]', 'Manage mounted projects')
    .action(async (action: string | undefined, args: string[]) => {
      const { handleProject } = await import('./project-cli.ts');
      const cmdArgs = [action || 'help'].filter(Boolean).concat(args || []);
      await handleProject(cmdArgs);
    });

  // Attachment subcommands
  cli.command('attachment [action]', 'Manage attachments')
    .action(async (action: string | undefined) => {
      const { handleAttachment } = await import('./attachment-cli.ts');
      await handleAttachment([action || 'fetch']);
    });

  // Daemon subcommands
  cli.command('daemon <action>', 'Manage background service')
    .action(async (action: string) => {
      const { handleDaemon } = await import('./daemon.ts');
      await handleDaemon(action);
    });

  // Codex subcommand
  cli.command('codex [...options]', 'Launch managed Codex session with remote approval')
    .allowUnknownOptions()
    .action(async function (this: { options: Record<string, unknown> }, options: string[]) {
      const { handleCodexCommand } = await import('./codex-launcher.ts');
      // cac parses flags into this.options; reconstruct raw argv for handleCodexCommand
      const parsed = this.options;
      const rawArgs: string[] = [];
      // Add parsed key-value options
      for (const [key, value] of Object.entries(parsed)) {
        if (key === '--') continue;
        if (typeof value === 'boolean') {
          if (value) rawArgs.push(`--${key}`);
        } else if (Array.isArray(value)) {
          for (const item of value) rawArgs.push(`--${key}`, String(item));
        } else {
          rawArgs.push(`--${key}`, String(value));
        }
      }
      // Add positional args after --
      if (Array.isArray(parsed['--'])) {
        rawArgs.push(...(parsed['--'] as string[]));
      }
      // Also include positional rest args
      if (options.length > 0) rawArgs.push(...options);
      await handleCodexCommand(rawArgs);
    });

  cli.help();

  try {
    cli.parse();
  } catch (err) {
    const command = process.argv[2];
    if (command) {
      console.error(`Unknown command: ${command}`);
      console.error('Run \x1b[36mworkspacecord help\x1b[0m for usage.');
    }
    process.exit(1);
  }
}
