import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sanitizeName,
  resolvePath,
  isPathAllowed,
  projectNameFromChannel,
  formatDuration,
  formatRelative,
  truncate,
  isUserAllowed,
  isAbortError,
  isAbortErrorMessage,
  detectNumberedOptions,
  detectYesNoPrompt,
  formatUptime,
  splitMessage,
  formatCost,
} from '../src/utils.ts';

describe('utils', () => {
  describe('sanitizeName', () => {
    it('lowercases and replaces special chars with dashes', () => {
      expect(sanitizeName('Hello World!')).toBe('hello-world');
    });

    it('collapses multiple dashes sequences', () => {
      expect(sanitizeName('foo   bar')).toBe('foo-bar');
    });

    it('trims leading and trailing dashes', () => {
      expect(sanitizeName('--test--')).toBe('test');
    });

    it('truncates to 50 chars', () => {
      const long = 'a'.repeat(100);
      expect(sanitizeName(long)).toHaveLength(50);
    });

    it('returns "session" for empty input', () => {
      expect(sanitizeName('')).toBe('session');
      expect(sanitizeName('!!!')).toBe('session');
    });
  });

  describe('resolvePath', () => {
    it('expands tilde to home directory', () => {
      const result = resolvePath('~/projects');
      expect(result).toMatch(/^\/.+\//);
      expect(result).toContain('projects');
    });

    it('returns absolute paths unchanged', () => {
      expect(resolvePath('/tmp/test')).toBe('/tmp/test');
    });

    it('resolves relative paths against cwd', () => {
      const result = resolvePath('./src');
      expect(result).toBe(process.cwd() + '/src');
    });
  });

  describe('isPathAllowed', () => {
    it('allows all paths when allowedPaths is empty', () => {
      expect(isPathAllowed('/any/path', [])).toBe(true);
    });

    it('allows path within allowed root', () => {
      expect(isPathAllowed('/home/user/project/src', ['/home/user/project'])).toBe(true);
    });

    it('rejects path outside allowed roots', () => {
      expect(isPathAllowed('/etc/passwd', ['/home/user'])).toBe(false);
    });
  });

  describe('projectNameFromChannel', () => {
    it('returns channel name as-is', () => {
      expect(projectNameFromChannel('my-project')).toBe('my-project');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3661000)).toBe('1h 1m');
    });
  });

  describe('formatRelative', () => {
    it('shows "just now" for recent timestamps', () => {
      const recent = Date.now() - 10000;
      expect(formatRelative(recent)).toBe('just now');
    });

    it('shows minutes ago', () => {
      const ts = Date.now() - 120000;
      expect(formatRelative(ts)).toBe('2m ago');
    });

    it('shows hours ago', () => {
      const ts = Date.now() - 3 * 3600000;
      expect(formatRelative(ts)).toBe('3h ago');
    });

    it('shows days ago', () => {
      const ts = Date.now() - 2 * 86400000;
      expect(formatRelative(ts)).toBe('2d ago');
    });
  });

  describe('truncate', () => {
    it('returns string unchanged if within max', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates with ellipsis', () => {
      expect(truncate('hello world', 8)).toBe('hello w…');
    });

    it('handles exact-length strings', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
  });

  describe('isUserAllowed', () => {
    it('allows all when allowAll is true', () => {
      expect(isUserAllowed('any-user', [], true)).toBe(true);
    });

    it('denies when allowedUsers is empty and allowAll is false', () => {
      expect(isUserAllowed('user', [], false)).toBe(false);
    });

    it('allows when user is in list', () => {
      expect(isUserAllowed('user-123', ['user-123', 'user-456'], false)).toBe(true);
    });

    it('denies when user is not in list', () => {
      expect(isUserAllowed('unknown', ['user-123'], false)).toBe(false);
    });
  });

  describe('isAbortError', () => {
    it('detects AbortError by name', () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      expect(isAbortError(abortErr)).toBe(true);
    });

    it('detects abort patterns in message', () => {
      expect(isAbortError(new Error('Task was cancelled'))).toBe(true);
      expect(isAbortError(new Error('Process killed'))).toBe(true);
      expect(isAbortError(new Error('Signal received'))).toBe(true);
      expect(isAbortError(new Error('Interrupted'))).toBe(true);
    });

    it('returns false for non-abort errors', () => {
      expect(isAbortError(new Error('Something went wrong'))).toBe(false);
    });
  });

  describe('isAbortErrorMessage', () => {
    it('returns true when any message matches an abort pattern', () => {
      expect(isAbortErrorMessage(['normal message', 'task was cancelled'])).toBe(true);
      expect(isAbortErrorMessage(['Abort requested'])).toBe(true);
    });

    it('returns false when no messages match', () => {
      expect(isAbortErrorMessage(['all good', 'no problems'])).toBe(false);
    });

    it('returns false for empty array', () => {
      expect(isAbortErrorMessage([])).toBe(false);
    });

    it('is case-insensitive', () => {
      expect(isAbortErrorMessage(['SIGNAL received'])).toBe(true);
      expect(isAbortErrorMessage(['INTERRUPTED'])).toBe(true);
    });
  });

  describe('detectNumberedOptions', () => {
    it('detects numbered options with a question preamble', () => {
      const text = 'Which approach do you prefer?\n1) Option A\n2) Option B\n3) Option C';
      const result = detectNumberedOptions(text);
      expect(result).toEqual(['Option A', 'Option B', 'Option C']);
    });

    it('detects options with dot notation', () => {
      const text = 'Which one?\n1. First choice\n2. Second choice';
      expect(detectNumberedOptions(text)).toEqual(['First choice', 'Second choice']);
    });

    it('detects question keyword "select" in preamble', () => {
      const text = 'Please select an option\n1) Alpha\n2) Beta';
      expect(detectNumberedOptions(text)).toEqual(['Alpha', 'Beta']);
    });

    it('detects question keyword "choose" in preamble', () => {
      const text = 'Please choose\n1) X\n2) Y';
      expect(detectNumberedOptions(text)).toEqual(['X', 'Y']);
    });

    it('returns null if fewer than 2 options', () => {
      const text = 'Which?\n1) Only one';
      expect(detectNumberedOptions(text)).toBeNull();
    });

    it('returns null if more than 6 options', () => {
      const lines = ['Which?\n'];
      for (let i = 1; i <= 7; i++) lines.push(`${i}) Option ${i}`);
      expect(detectNumberedOptions(lines.join('\n'))).toBeNull();
    });

    it('returns null if an option is longer than 80 chars', () => {
      const longOption = 'A'.repeat(81);
      const text = `Which?\n1) ${longOption}\n2) Short`;
      expect(detectNumberedOptions(text)).toBeNull();
    });

    it('returns null if there are more than 3 non-empty lines after options', () => {
      const text =
        'Which?\n1) A\n2) B\nline1\nline2\nline3\nline4';
      expect(detectNumberedOptions(text)).toBeNull();
    });

    it('returns null if no question preamble', () => {
      const text = 'Here are some items\n1) Foo\n2) Bar';
      expect(detectNumberedOptions(text)).toBeNull();
    });

    it('detects preamble ending with question mark', () => {
      const text = 'What do you think?\n1) Yes\n2) No';
      expect(detectNumberedOptions(text)).toEqual(['Yes', 'No']);
    });

    it('allows up to 3 trailing lines after options', () => {
      const text = 'Which?\n1) A\n2) B\nNote 1\nNote 2\nNote 3';
      expect(detectNumberedOptions(text)).toEqual(['A', 'B']);
    });
  });

  describe('detectYesNoPrompt', () => {
    it('detects y/n pattern', () => {
      expect(detectYesNoPrompt('Continue? (y/n)')).toBe(true);
    });

    it('detects yes/no pattern', () => {
      expect(detectYesNoPrompt('Are you sure? yes/no')).toBe(true);
    });

    it('detects confirm keyword', () => {
      expect(detectYesNoPrompt('Please confirm the action')).toBe(true);
    });

    it('detects proceed keyword', () => {
      expect(detectYesNoPrompt('Do you want to proceed')).toBe(true);
    });

    it('detects "should" with question mark', () => {
      expect(detectYesNoPrompt('Should I continue?')).toBe(true);
    });

    it('detects "would you" with question mark', () => {
      expect(detectYesNoPrompt('Would you like to save?')).toBe(true);
    });

    it('detects "do you want" with question mark', () => {
      expect(detectYesNoPrompt('Do you want to delete this?')).toBe(true);
    });

    it('detects "shall" with question mark', () => {
      expect(detectYesNoPrompt('Shall we begin?')).toBe(true);
    });

    it('returns false for normal text without patterns', () => {
      expect(detectYesNoPrompt('Hello world')).toBe(false);
    });

    it('returns false for question without should/would/do you want/shall', () => {
      expect(detectYesNoPrompt('What is your name?')).toBe(false);
    });
  });

  describe('formatUptime', () => {
    it('formats seconds', () => {
      const startTime = Date.now() - 30_000;
      expect(formatUptime(startTime)).toBe('30s');
    });

    it('formats minutes', () => {
      const startTime = Date.now() - 5 * 60_000;
      expect(formatUptime(startTime)).toBe('5m');
    });

    it('formats hours and minutes', () => {
      const startTime = Date.now() - (2 * 3_600_000 + 15 * 60_000);
      expect(formatUptime(startTime)).toBe('2h 15m');
    });

    it('formats days and hours', () => {
      const startTime = Date.now() - (3 * 86_400_000 + 5 * 3_600_000);
      expect(formatUptime(startTime)).toBe('3d 5h');
    });
  });

  describe('splitMessage', () => {
    it('returns single-element array for short text', () => {
      expect(splitMessage('hello')).toEqual(['hello']);
    });

    it('returns single-element for text exactly at max', () => {
      const text = 'a'.repeat(1900);
      expect(splitMessage(text)).toEqual([text]);
    });

    it('splits long text into chunks', () => {
      const text = 'a'.repeat(4000);
      const chunks = splitMessage(text);
      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toHaveLength(1900);
      expect(chunks[1]).toHaveLength(1900);
      expect(chunks[2]).toHaveLength(200);
      expect(chunks.join('')).toBe(text);
    });

    it('respects custom max parameter', () => {
      const text = 'a'.repeat(100);
      const chunks = splitMessage(text, 30);
      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toHaveLength(30);
      expect(chunks[3]).toHaveLength(10);
    });
  });

  describe('formatCost', () => {
    it('formats zero cost', () => {
      expect(formatCost(0)).toBe('$0.00');
    });

    it('formats small costs with 4 decimal places', () => {
      expect(formatCost(0.0012)).toBe('$0.0012');
      expect(formatCost(0.0099)).toBe('$0.0099');
    });

    it('formats normal costs with 2 decimal places', () => {
      expect(formatCost(1.5)).toBe('$1.50');
      expect(formatCost(12.99)).toBe('$12.99');
    });

    it('formats costs at the boundary (0.01)', () => {
      expect(formatCost(0.01)).toBe('$0.01');
    });
  });
});
