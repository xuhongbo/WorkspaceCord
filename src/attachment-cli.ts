import { fetchRegisteredAttachments } from './discord/attachment-inbox.ts';

function printHelp(): void {
  console.log(`
workspacecord attachment — fetch registered Discord attachments

Usage:
  workspacecord attachment fetch --session <session-id> --message <message-id> --attachment <attachment-id>
  workspacecord attachment fetch --session <session-id> --message <message-id> --all
`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

export async function handleAttachment(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'fetch': {
      const sessionId = readFlag(rest, '--session');
      const messageId = readFlag(rest, '--message');
      const attachmentId = readFlag(rest, '--attachment');
      const all = rest.includes('--all');
      const currentSessionId = readFlag(rest, '--current-session') ?? process.env.workspacecord_CURRENT_SESSION_ID;

      if (!sessionId || !messageId || (!attachmentId && !all)) {
        console.error(
          'Usage: workspacecord attachment fetch --session <session-id> --message <message-id> (--attachment <attachment-id> | --all)',
        );
        process.exit(1);
      }

      const downloaded = await fetchRegisteredAttachments({
        sessionId,
        messageId,
        attachmentId,
        all,
        currentSessionId,
      });
      console.log(JSON.stringify(downloaded, null, 2));
      return;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;

    default:
      console.error(`Unknown attachment subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}
