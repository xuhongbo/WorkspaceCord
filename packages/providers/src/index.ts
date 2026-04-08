import type { Provider, ProviderName } from './types.ts';
import { ClaudeProvider } from './claude-provider.ts';

export type {
  Provider,
  ProviderName,
  ProviderEvent,
  ProviderSessionOptions,
  ProviderCanUseTool,
  ContentBlock,
  ImageMediaType,
  TextBlock,
  ImageBlock,
  LocalImageBlock,
} from './types.ts';

const providers = new Map<ProviderName, Provider>();

providers.set('claude', new ClaudeProvider());

let codexLoadAttempted = false;

async function loadCodexProvider(): Promise<void> {
  try {
    const { CodexProvider } = await import('./codex-provider.ts');
    providers.set('codex', new CodexProvider());
    codexLoadAttempted = true;
  } catch (err: unknown) {
    codexLoadAttempted = true;
    throw new Error(
      `Codex provider is unavailable. Install @openai/codex-sdk manually. Root cause: ${(err as Error).message}`,
    );
  }
}

export function getProvider(name: ProviderName): Provider {
  const provider = providers.get(name);
  if (provider) return provider;
  throw new Error(`Provider "${name}" not loaded. Call ensureProvider("${name}") first.`);
}

export async function ensureProvider(name: ProviderName): Promise<Provider> {
  if (providers.has(name)) return providers.get(name)!;

  if (name === 'codex' && !codexLoadAttempted) {
    await loadCodexProvider();
    return providers.get('codex')!;
  }

  if (name === 'codex') {
    throw new Error(
      'Codex provider is unavailable. Install @openai/codex-sdk and restart workspacecord.',
    );
  }

  throw new Error(`Unknown provider: ${name}`);
}

export async function isProviderAvailable(name: ProviderName): Promise<boolean> {
  if (providers.has(name)) return true;
  if (name === 'codex') {
    try {
      await ensureProvider('codex');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function listProviders(): ProviderName[] {
  return ['claude', 'codex'];
}
