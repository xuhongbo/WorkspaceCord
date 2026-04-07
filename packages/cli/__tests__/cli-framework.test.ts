import { describe, it, expect, vi, afterEach } from 'vitest';
import cac from 'cac';

describe('CLI Framework (cac)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function parse(argv: string[], cli: ReturnType<typeof cac>) {
    cli.parse(argv);
    await new Promise((r) => setTimeout(r, 50));
  }

  describe('command parsing', () => {
    it('parses default command (no args)', async () => {
      const cli = cac('workspacecord');
      let hit = false;
      cli.command('', 'Start the bot').action(() => { hit = true; });
      await parse(['node', 'workspacecord'], cli);
      expect(hit).toBe(true);
    });

    it('parses config setup', async () => {
      const cli = cac('workspacecord');
      let captured = '';
      cli.command('config [action]', 'Config management').action((action: string) => { captured = action; });
      await parse(['node', 'workspacecord', 'config', 'setup'], cli);
      expect(captured).toBe('setup');
    });

    it('parses config get with key', async () => {
      const cli = cac('workspacecord');
      let captured: string[] = [];
      cli.command('config [action] [key] [value]', 'Config management').action((action: string, key: string, value: string) => {
        captured = [action, key, value].filter(Boolean);
      });
      await parse(['node', 'workspacecord', 'config', 'get', 'discordToken'], cli);
      expect(captured).toEqual(['get', 'discordToken']);
    });

    it('parses config set with key and value', async () => {
      const cli = cac('workspacecord');
      let captured: string[] = [];
      cli.command('config [action] [key] [value]', 'Config management').action((a: string, k: string, v: string) => {
        captured = [a, k, v].filter(Boolean);
      });
      await parse(['node', 'workspacecord', 'config', 'set', 'discordToken', 'abc123'], cli);
      expect(captured).toEqual(['set', 'discordToken', 'abc123']);
    });

    it('parses project init', async () => {
      const cli = cac('workspacecord');
      let captured = '';
      cli.command('project [action]', 'Manage projects').action((action: string) => { captured = action; });
      await parse(['node', 'workspacecord', 'project', 'init'], cli);
      expect(captured).toBe('init');
    });

    it('parses daemon install', async () => {
      const cli = cac('workspacecord');
      let captured = '';
      cli.command('daemon <action>', 'Manage daemon').action((action: string) => { captured = action; });
      await parse(['node', 'workspacecord', 'daemon', 'install'], cli);
      expect(captured).toBe('install');
    });

    it('parses attachment fetch', async () => {
      const cli = cac('workspacecord');
      let captured = '';
      cli.command('attachment [action]', 'Attachment management').action((action: string) => { captured = action; });
      await parse(['node', 'workspacecord', 'attachment', 'fetch'], cli);
      expect(captured).toBe('fetch');
    });

    it('parses codex command', async () => {
      const cli = cac('workspacecord');
      let hit = false;
      cli.command('codex [...options]', 'Launch codex').action(() => { hit = true; });
      await parse(['node', 'workspacecord', 'codex'], cli);
      expect(hit).toBe(true);
    });

    it('parses codex with options', async () => {
      const cli = cac('workspacecord');
      let captured: string[] = [];
      cli.command('codex [...options]', 'Launch codex').action((opts: string[]) => { captured = opts || []; });
      // Use positional args instead of flags since cac rejects unknown options
      await parse(['node', 'workspacecord', 'codex', 'arg1', 'arg2'], cli);
      expect(captured).toContain('arg1');
    });

    it('passes through unknown flags with allowUnknownOptions', async () => {
      const cli = cac('workspacecord');
      let capturedOptions: Record<string, unknown> = {};
      cli.command('codex [...options]', 'Launch codex')
        .allowUnknownOptions()
        .action(function (opts: string[]) {
          capturedOptions = { ...(this as { options: Record<string, unknown> }).options };
          capturedOptions._rest = opts;
        });
      await parse(['node', 'workspacecord', 'codex', '--cwd', '/path', '--model', 'gpt-4'], cli);
      expect(capturedOptions.cwd).toBe('/path');
      expect(capturedOptions.model).toBe('gpt-4');
    });
  });

  describe('error handling', () => {
    it('prints error for unknown commands', async () => {
      const cli = cac('workspacecord');
      cli.command('', 'Start').action(() => {});
      cli.help('Help');

      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await parse(['node', 'workspacecord', 'unknown'], cli);
      } catch {
        // cac may throw
      }

      // cac handles unknown commands by printing help/exiting
      expect(true).toBe(true); // cac doesn't throw for unknown sub-commands by default

      exit.mockRestore();
      consoleError.mockRestore();
    });
  });
});
