import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Provider, ProviderEvent, ProviderSessionOptions, ContentBlock } from './types.ts';
import {
  buildCodexOptions,
  buildThreadOptions,
  parseFileChanges,
  parseTodoItems,
} from './codex/helpers.ts';

type InputPart = { type: string; text?: string; path?: string };
type CodexEvent = {
  type: string;
  thread_id?: string;
  item?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: string;
  message?: string;
};
type CodexThread = {
  runStreamed(input: string | InputPart[]): Promise<{ events: AsyncIterable<CodexEvent> }>;
};
type CodexClient = {
  startThread(options: Record<string, unknown>): CodexThread;
  resumeThread(sessionId: string, options: Record<string, unknown>): CodexThread;
};
type CodexConstructor = new (options: Record<string, unknown>) => CodexClient;

// Lazy-loaded SDK constructor — populated on first use
let Codex: CodexConstructor | null = null;

async function loadSdk(): Promise<void> {
  if (Codex) return;
  const mod = await import('@openai/codex-sdk');
  Codex = mod.Codex as CodexConstructor;
}

// AGENTS.md sentinel for persona injection
const SENTINEL_START = '<!-- workspacecord-persona-start -->';
const SENTINEL_END = '<!-- workspacecord-persona-end -->';

interface AgentsMdInjectionState {
  existed: boolean;
}

function stripInjectedAgentsMd(content: string): string {
  return content.replace(
    new RegExp(`${escapeRegex(SENTINEL_START)}[\\s\\S]*?${escapeRegex(SENTINEL_END)}\\n?`, 'g'),
    '',
  );
}

function injectAgentsMd(directory: string, parts: string[]): AgentsMdInjectionState | null {
  if (parts.length === 0) return null;

  const agentsPath = join(directory, 'AGENTS.md');
  const injected = `${SENTINEL_START}\n${parts.join('\n\n')}\n${SENTINEL_END}`;
  const existed = existsSync(agentsPath);
  const current = existed ? readFileSync(agentsPath, 'utf-8') : '';
  const cleaned = stripInjectedAgentsMd(current).trimEnd();

  writeFileSync(agentsPath, cleaned ? `${cleaned}\n\n${injected}\n` : `${injected}\n`, 'utf-8');

  return { existed };
}

function restoreAgentsMd(directory: string, state: AgentsMdInjectionState | null): void {
  if (!state) return;

  const agentsPath = join(directory, 'AGENTS.md');
  if (!existsSync(agentsPath)) return;

  const cleaned = stripInjectedAgentsMd(readFileSync(agentsPath, 'utf-8')).trimEnd();
  if (!state.existed && !cleaned) {
    try {
      unlinkSync(agentsPath);
    } catch {
      /* may already be deleted */
    }
    return;
  }

  writeFileSync(agentsPath, cleaned ? `${cleaned}\n` : '', 'utf-8');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function writeImagesToTemp(blocks: ContentBlock[]): {
  textParts: string[];
  localImages: Array<{ type: 'local_image'; path: string }>;
} {
  const textParts: string[] = [];
  const localImages: Array<{ type: 'local_image'; path: string }> = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      const dir = mkdtempSync(join(tmpdir(), 'workspacecord-img-'));
      const ext = block.source.media_type.split('/')[1] || 'png';
      const filePath = join(dir, `image.${ext}`);
      writeFileSync(filePath, Buffer.from(block.source.data, 'base64'));
      localImages.push({ type: 'local_image', path: filePath });
    } else if (block.type === 'local_image') {
      localImages.push(block);
    }
  }

  return { textParts, localImages };
}

export class CodexProvider implements Provider {
  readonly name = 'codex' as const;

  supports(feature: string): boolean {
    return ['command_execution', 'file_changes', 'reasoning', 'todo_list', 'continue'].includes(
      feature,
    );
  }

  async *sendPrompt(
    prompt: string | ContentBlock[],
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent> {
    await loadSdk();

    let input: string | InputPart[];
    if (typeof prompt === 'string') {
      input = prompt;
    } else {
      const { textParts, localImages } = writeImagesToTemp(prompt);
      const inputParts: InputPart[] = [];
      for (const img of localImages) {
        inputParts.push({ type: 'local_image', path: img.path });
      }
      if (textParts.length > 0) {
        inputParts.push({ type: 'text', text: textParts.join('\n') });
      }
      input =
        inputParts.length === 1 && inputParts[0].type === 'text'
          ? (inputParts[0].text ?? '')
          : inputParts;
    }

    let originalAgents: AgentsMdInjectionState | null = null;
    try {
      originalAgents = injectAgentsMd(options.directory, options.systemPromptParts);
      const codex = new Codex!(buildCodexOptions());
      const threadOptions = buildThreadOptions(options);

      const thread = options.providerSessionId
        ? codex.resumeThread(options.providerSessionId, threadOptions)
        : codex.startThread(threadOptions);

      const { events } = await thread.runStreamed(input);
      yield* this.translateEvents(events, options.abortController);
    } finally {
      restoreAgentsMd(options.directory, originalAgents);
    }
  }

  async *continueSession(options: ProviderSessionOptions): AsyncGenerator<ProviderEvent> {
    await loadSdk();

    if (!options.providerSessionId) {
      yield { type: 'error', message: 'No session to continue — no previous thread ID.' };
      return;
    }

    let originalAgents: AgentsMdInjectionState | null = null;
    try {
      originalAgents = injectAgentsMd(options.directory, options.systemPromptParts);
      const codex = new Codex!(buildCodexOptions());
      const thread = codex.resumeThread(options.providerSessionId, buildThreadOptions(options));
      const { events } = await thread.runStreamed('Continue from where you left off.');
      yield* this.translateEvents(events, options.abortController);
    } finally {
      restoreAgentsMd(options.directory, originalAgents);
    }
  }

  private async *translateEvents(
    events: AsyncIterable<CodexEvent>,
    abortController: AbortController,
  ): AsyncGenerator<ProviderEvent> {
    const messageText = new Map<string, string>();
    const startTime = Date.now();

    try {
      for await (const event of events) {
        if (abortController.signal.aborted) break;

        switch (event.type) {
          case 'thread.started':
            yield { type: 'session_init', providerSessionId: event.thread_id || '' };
            break;

          case 'item.started':
          case 'item.updated': {
            const item = event.item;
            if (!item) break;
            if (item.type === 'agent_message') {
              const itemId = String(item.id || '');
              const prev = messageText.get(itemId) || '';
              const text = String(item.text || '');
              if (text.length > prev.length) {
                yield { type: 'text_delta', text: text.slice(prev.length) };
                messageText.set(itemId, text);
              }
            }

            if (item.type === 'reasoning' && event.type === 'item.updated') {
              const text = String(item.summary || item.content || '');
              if (text) yield { type: 'reasoning', text };
            }
            break;
          }

          case 'item.completed': {
            const item = event.item;
            if (!item) break;

            switch (item.type) {
              case 'agent_message': {
                const itemId = String(item.id || '');
                const prev = messageText.get(itemId) || '';
                const text = String(item.text || '');
                if (text.length > prev.length) {
                  yield { type: 'text_delta', text: text.slice(prev.length) };
                }
                messageText.delete(itemId);
                break;
              }

              case 'command_execution':
                yield {
                  type: 'command_execution',
                  command: String(item.command || ''),
                  output: String(item.aggregated_output ?? item.output ?? ''),
                  exitCode:
                    typeof item.exit_code === 'number'
                      ? item.exit_code
                      : typeof item.exitCode === 'number'
                        ? item.exitCode
                        : null,
                  status: String(item.status || 'completed'),
                };
                break;

              case 'file_change': {
                const changes = parseFileChanges(item);
                if (changes.length > 0) yield { type: 'file_change', changes };
                break;
              }

              case 'reasoning': {
                const text = String(item.summary || item.content || '');
                if (text) yield { type: 'reasoning', text };
                break;
              }

              case 'todo_list': {
                const items = parseTodoItems(item);
                if (items.length > 0) yield { type: 'todo_list', items };
                break;
              }

              case 'mcp_tool_call':
                yield {
                  type: 'tool_start',
                  toolName: `${String(item.server || '')}/${String(item.tool || '')}`,
                  toolInput: JSON.stringify(item.arguments || item.input || {}),
                };
                if (item.status === 'completed' || item.status === 'failed') {
                  yield {
                    type: 'tool_result',
                    toolName: `${String(item.server || '')}/${String(item.tool || '')}`,
                    result:
                      typeof item.output === 'string'
                        ? item.output
                        : JSON.stringify(item.output || ''),
                    isError: item.status === 'failed',
                  };
                }
                break;

              case 'web_search':
                yield { type: 'web_search', query: String(item.query || '') };
                break;

              case 'error':
                yield { type: 'error', message: String(item.message || 'Unknown error') };
                break;
            }
            break;
          }

          case 'turn.completed': {
            const usage = event.usage;
            const inputTokens = usage?.input_tokens || 0;
            const outputTokens = usage?.output_tokens || 0;
            const costUsd = (inputTokens * 2 + outputTokens * 8) / 1_000_000;
            yield {
              type: 'result',
              success: true,
              costUsd,
              durationMs: Date.now() - startTime,
              numTurns: 1,
              errors: [],
            };
            break;
          }

          case 'turn.failed':
            yield {
              type: 'result',
              success: false,
              costUsd: 0,
              durationMs: Date.now() - startTime,
              numTurns: 1,
              errors: [event.error || 'Turn failed'],
            };
            break;

          case 'error':
            yield { type: 'error', message: event.message || 'Unknown error' };
            break;
        }
      }
    } catch (err: unknown) {
      if (!abortController.signal.aborted) {
        yield { type: 'error', message: (err as Error).message || 'Codex stream error' };
      }
    }
  }
}
