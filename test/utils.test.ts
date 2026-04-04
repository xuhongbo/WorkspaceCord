import { describe, it, expect } from 'vitest';
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
});
