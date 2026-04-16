// 轻量级运行时 schema 校验 — 零依赖
// 用于持久化数据的加载校验，避免因磁盘数据损坏或字段缺失导致的启动崩溃。
// 校验失败时返回受控错误与修复后的对象，而不是抛出未捕获的异常。

export type SchemaIssue = {
  path: string;
  message: string;
};

export type SchemaResult<T> =
  | { ok: true; value: T; issues: SchemaIssue[] }
  | { ok: false; issues: SchemaIssue[] };

export interface FieldSpec<T> {
  parse(input: unknown, path: string, issues: SchemaIssue[]): T | undefined;
}

function pushIssue(issues: SchemaIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

export const s = {
  string(options: { optional?: boolean; default?: string } = {}): FieldSpec<string | undefined> {
    return {
      parse(input, path, issues) {
        if (input === undefined || input === null) {
          if (options.optional) return options.default;
          pushIssue(issues, path, 'expected string, got ' + describe(input));
          return options.default;
        }
        if (typeof input !== 'string') {
          pushIssue(issues, path, 'expected string, got ' + describe(input));
          return options.default;
        }
        return input;
      },
    };
  },

  number(options: { optional?: boolean; default?: number; integer?: boolean } = {}): FieldSpec<number | undefined> {
    return {
      parse(input, path, issues) {
        if (input === undefined || input === null) {
          if (options.optional) return options.default;
          pushIssue(issues, path, 'expected number, got ' + describe(input));
          return options.default;
        }
        if (typeof input !== 'number' || !Number.isFinite(input)) {
          pushIssue(issues, path, 'expected finite number, got ' + describe(input));
          return options.default;
        }
        if (options.integer && !Number.isInteger(input)) {
          pushIssue(issues, path, 'expected integer, got ' + input);
          return options.default;
        }
        return input;
      },
    };
  },

  boolean(options: { optional?: boolean; default?: boolean } = {}): FieldSpec<boolean | undefined> {
    return {
      parse(input, path, issues) {
        if (input === undefined || input === null) {
          if (options.optional) return options.default;
          pushIssue(issues, path, 'expected boolean, got ' + describe(input));
          return options.default;
        }
        if (typeof input !== 'boolean') {
          pushIssue(issues, path, 'expected boolean, got ' + describe(input));
          return options.default;
        }
        return input;
      },
    };
  },

  literal<const T extends string>(values: readonly T[], options: { optional?: boolean; default?: T } = {}): FieldSpec<T | undefined> {
    return {
      parse(input, path, issues) {
        if (input === undefined || input === null) {
          if (options.optional) return options.default;
          pushIssue(issues, path, 'expected one of [' + values.join(', ') + '], got ' + describe(input));
          return options.default;
        }
        if (typeof input !== 'string' || !values.includes(input as T)) {
          pushIssue(issues, path, 'expected one of [' + values.join(', ') + '], got ' + describe(input));
          return options.default;
        }
        return input as T;
      },
    };
  },

  array<T>(item: FieldSpec<T>, options: { optional?: boolean; default?: T[] } = {}): FieldSpec<T[] | undefined> {
    return {
      parse(input, path, issues) {
        if (input === undefined || input === null) {
          if (options.optional) return options.default;
          pushIssue(issues, path, 'expected array, got ' + describe(input));
          return options.default ?? [];
        }
        if (!Array.isArray(input)) {
          pushIssue(issues, path, 'expected array, got ' + describe(input));
          return options.default ?? [];
        }
        const out: T[] = [];
        for (let i = 0; i < input.length; i++) {
          const parsed = item.parse(input[i], `${path}[${i}]`, issues);
          if (parsed !== undefined) out.push(parsed);
        }
        return out;
      },
    };
  },

  unknown(): FieldSpec<unknown> {
    return {
      parse(input) {
        return input;
      },
    };
  },

  record<T>(value: FieldSpec<T>, options: { optional?: boolean } = {}): FieldSpec<Record<string, T> | undefined> {
    return {
      parse(input, path, issues) {
        if (input === undefined || input === null) {
          if (options.optional) return undefined;
          pushIssue(issues, path, 'expected object, got ' + describe(input));
          return undefined;
        }
        if (typeof input !== 'object' || Array.isArray(input)) {
          pushIssue(issues, path, 'expected object, got ' + describe(input));
          return undefined;
        }
        const out: Record<string, T> = {};
        for (const [key, raw] of Object.entries(input)) {
          const parsed = value.parse(raw, `${path}.${key}`, issues);
          if (parsed !== undefined) out[key] = parsed;
        }
        return out;
      },
    };
  },
};

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * 从未知输入中解析一个对象数组，对每个元素应用 parseItem。
 * - 非数组：返回空数组并记录一条 issue
 * - 元素解析失败：跳过该元素，其他继续
 * 即便出现错误也不抛异常，保证持久化恢复过程的鲁棒性。
 */
export function parseList<T>(
  input: unknown,
  parseItem: (raw: unknown, index: number, issues: SchemaIssue[]) => T | undefined,
  label: string,
): SchemaResult<T[]> {
  const issues: SchemaIssue[] = [];
  if (input === null || input === undefined) {
    return { ok: true, value: [], issues };
  }
  if (!Array.isArray(input)) {
    issues.push({ path: label, message: 'expected array, got ' + describe(input) });
    return { ok: true, value: [], issues };
  }
  const out: T[] = [];
  for (let i = 0; i < input.length; i++) {
    const parsed = parseItem(input[i], i, issues);
    if (parsed !== undefined) out.push(parsed);
  }
  return { ok: true, value: out, issues };
}

export function formatIssues(issues: SchemaIssue[], limit = 5): string {
  if (issues.length === 0) return '';
  const shown = issues.slice(0, limit).map((i) => `  - ${i.path}: ${i.message}`);
  const suffix = issues.length > limit ? `\n  ...and ${issues.length - limit} more` : '';
  return shown.join('\n') + suffix;
}
