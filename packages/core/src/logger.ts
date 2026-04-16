import pino, { type Logger as PinoLogger, type ChildLoggerOptions } from 'pino';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

// 结构化日志中需要脱敏的敏感键；匹配上就用 "********" 覆盖。
// pino 的 redact 用通配符路径，这里在应用层做一层深拷贝 + 递归替换，兼容任意嵌套。
const SENSITIVE_KEY_PATTERN =
  /token|api[_-]?key|authorization|auth[_-]?token|password|secret|cookie|bearer/i;

function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // 防御深层循环
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k) && typeof v === 'string') {
      out[k] = v.length <= 8 ? '********' : `${v.slice(0, 4)}********${v.slice(-4)}`;
    } else {
      out[k] = redactSensitive(v, depth + 1);
    }
  }
  return out;
}

function maskCtx(ctx?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!ctx) return ctx;
  return redactSensitive(ctx) as Record<string, unknown>;
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
      pino.debug({ ...maskCtx(ctx), msg });
    },
    info(msg: string, ctx?: Record<string, unknown>) {
      pino.info({ ...maskCtx(ctx), msg });
    },
    warn(msg: string, ctx?: Record<string, unknown>) {
      pino.warn({ ...maskCtx(ctx), msg });
    },
    error(msg: string, ctx?: Record<string, unknown>) {
      pino.error({ ...maskCtx(ctx), msg });
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
