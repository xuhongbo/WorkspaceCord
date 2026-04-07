import pino, { type Logger as PinoLogger, type ChildLoggerOptions } from 'pino';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  level?: string;
  module?: string;
  traceId?: string;
}

const formatters = {
  level(label: string) {
    return { level: label };
  },
};

const baseTransport = pino.destination({
  sync: true,
});

function createPinoInstance(options: LoggerOptions = {}): PinoLogger {
  const isDevelopment = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const base = { ...(options.module ? { module: options.module } : {}), ...(options.traceId ? { traceId: options.traceId } : {}) };

  return pino({
    level: options.level ?? (isDevelopment ? 'debug' : 'info'),
    formatters,
    base,
  }, isDevelopment ? undefined : baseTransport);
}

let defaultLoggerInstance: Logger;

export function createLogger(options: LoggerOptions = {}): Logger {
  const pino = createPinoInstance(options);

  return {
    debug(msg: string, ctx?: Record<string, unknown>) {
      pino.debug({ ...ctx, msg });
    },
    info(msg: string, ctx?: Record<string, unknown>) {
      pino.info({ ...ctx, msg });
    },
    warn(msg: string, ctx?: Record<string, unknown>) {
      pino.warn({ ...ctx, msg });
    },
    error(msg: string, ctx?: Record<string, unknown>) {
      pino.error({ ...ctx, msg });
    },
    child(bindings: Record<string, unknown>): Logger {
      return createLogger({ ...options, module: (bindings.module as string) ?? options.module });
    },
  };
}

export function getLogger(): Logger {
  if (!defaultLoggerInstance) {
    defaultLoggerInstance = createLogger();
  }
  return defaultLoggerInstance;
}
