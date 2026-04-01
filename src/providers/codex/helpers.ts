import { config } from '../../config.ts';
import type { ProviderSessionOptions } from '../types.ts';

export function buildCodexOptions(): Record<string, unknown> {
  const codexOpts: Record<string, unknown> = {};
  if (config.codexApiKey) codexOpts.apiKey = config.codexApiKey;
  if (config.codexBaseUrl) codexOpts.baseUrl = config.codexBaseUrl;
  if (config.codexPath) codexOpts.codexPathOverride = config.codexPath;
  return codexOpts;
}

export function buildThreadOptions(options: ProviderSessionOptions): Record<string, unknown> {
  const threadOptions: Record<string, unknown> = {
    workingDirectory: options.directory,
    skipGitRepoCheck: true,
  };
  if (options.model) threadOptions.model = options.model;
  if (options.sandboxMode) threadOptions.sandboxMode = options.sandboxMode;
  if (options.approvalPolicy) threadOptions.approvalPolicy = options.approvalPolicy;
  if (options.networkAccessEnabled !== undefined) {
    threadOptions.networkAccessEnabled = options.networkAccessEnabled;
  }
  if (options.webSearchMode && options.webSearchMode !== 'disabled') {
    threadOptions.webSearchMode = options.webSearchMode;
  }
  if (options.modelReasoningEffort) {
    threadOptions.modelReasoningEffort = options.modelReasoningEffort;
  }
  return threadOptions;
}

export function parseFileChanges(item: Record<string, unknown>): Array<{
  filePath: string;
  changeKind: 'add' | 'update' | 'delete';
}> {
  const raw = (item.changes || item.files || []) as Array<Record<string, unknown>>;
  return raw.map((f) => ({
    filePath: String(f.path || f.file_path || f.filePath || ''),
    changeKind: (f.kind || f.change_kind || f.changeKind || 'update') as
      | 'add'
      | 'update'
      | 'delete',
  }));
}

export function parseTodoItems(
  item: Record<string, unknown>,
): Array<{ text: string; completed: boolean }> {
  const raw = (item.items || item.todos || []) as Array<Record<string, unknown>>;
  return raw.map((t) => ({
    text: String(t.text || t.description || ''),
    completed: Boolean(t.completed ?? t.done ?? false),
  }));
}
