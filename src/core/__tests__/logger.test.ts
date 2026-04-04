import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, getLogger } from '../logger.ts';

describe('Logger', () => {
  let consoleOutput: Array<{ level: string; msg: string }>;
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    consoleOutput = [];
    originalStdoutWrite = process.stdout.write;

    // Capture stdout for test
    process.stdout.write = ((chunk: Buffer | string, ...args: unknown[]) => {
      if (typeof chunk === 'string') {
        try {
          const parsed = JSON.parse(chunk);
          consoleOutput.push({ level: parsed.level, msg: parsed.msg });
        } catch {
          // Not JSON, ignore
        }
      }
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  describe('createLogger', () => {
    it('creates a logger with debug/info/warn/error methods', () => {
      const logger = createLogger({ level: 'debug' });

      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('logs messages with context', () => {
      const logger = createLogger({ level: 'debug' });
      logger.info('test message', { key: 'value' });

      const lastEntry = consoleOutput[consoleOutput.length - 1];
      expect(lastEntry.msg).toBe('test message');
    });

    it('supports child loggers with context', () => {
      const logger = createLogger({ level: 'debug' });
      const child = logger.child({ module: 'TestModule' });

      child.info('child message');

      const lastEntry = consoleOutput[consoleOutput.length - 1];
      expect(lastEntry.msg).toBe('child message');
    });
  });

  describe('getLogger', () => {
    it('returns the same instance on repeated calls', () => {
      const a = getLogger();
      const b = getLogger();
      expect(a).toBe(b);
    });
  });
});
