import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Provider, ProviderEvent, ProviderSessionOptions, ContentBlock, TerminalReason } from './types.ts';

function mapClaudeTerminalReason(raw: string | undefined): TerminalReason | undefined {
  if (!raw) return undefined;
  switch (raw) {
    case 'completed':
      return 'completed';
    case 'max_turns':
      return 'max_turns';
    case 'blocking_limit':
    case 'rapid_refill_breaker':
      return 'rate_limited';
    case 'prompt_too_long':
      return 'context_too_long';
    case 'image_error':
      return 'image_error';
    case 'model_error':
      return 'model_error';
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'aborted';
    case 'stop_hook_prevented':
    case 'hook_stopped':
      return 'hook_stopped';
    case 'tool_deferred':
      return 'tool_deferred';
    default:
      return 'error';
  }
}

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
type ClaudeStreamEvent = {
  type?: string;
  content_block?: { type?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
};
type ClaudeSystemMessage = SDKMessage & {
  subtype?: string;
  session_id?: string;
  task_id?: string;
  description?: string;
  last_tool_name?: string;
  summary?: string;
  status?: string;
};
type ClaudeUserMessage = SDKMessage & {
  message?: {
    content?: Array<{ type?: string; content?: unknown } | { type?: string; text?: string }>;
  };
};
type ClaudeResultMessage = SDKMessage & {
  subtype?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  errors?: string[];
  terminal_reason?: string;
};

function extractImagePath(toolName: string, toolInput: string): string | null {
  try {
    const data = JSON.parse(toolInput);
    if (toolName === 'Write' || toolName === 'Read') {
      const filePath: string = data.file_path;
      if (
        filePath &&
        IMAGE_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase())
      ) {
        return filePath;
      }
    }
  } catch {
    /* incomplete or invalid JSON */
  }
  return null;
}

function buildClaudeSystemPrompt(
  parts: string[],
): string | { type: 'preset'; preset: 'claude_code'; append?: string } {
  if (parts.length > 0) {
    return { type: 'preset', preset: 'claude_code', append: parts.join('\n\n') };
  }
  return { type: 'preset', preset: 'claude_code' };
}

export class ClaudeProvider implements Provider {
  readonly name = 'claude' as const;

  supports(feature: string): boolean {
    return [
      'resume_from_terminal',
      'plugins',
      'ask_user_question',
      'mode_switching',
      'continue',
    ].includes(feature);
  }

  async *sendPrompt(
    prompt: string | ContentBlock[],
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent> {
    const systemPrompt = buildClaudeSystemPrompt(options.systemPromptParts);
    const isBypass = options.claudePermissionMode === 'bypass';

    function buildQueryPrompt(): string | AsyncIterable<SDKUserMessage> {
      if (typeof prompt === 'string') return prompt;
      // Filter out LocalImageBlock (not supported by Claude directly)
      const claudeBlocks = (prompt as ContentBlock[]).filter((b) => b.type !== 'local_image');
      const userMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: claudeBlocks },
        parent_tool_use_id: null,
        session_id: '',
      };
      return (async function* () {
        yield userMessage;
      })();
    }

    let retried = false;
    let resumeId = options.providerSessionId;

    while (true) {
      let failed = false;
      const stream = query({
        prompt: buildQueryPrompt(),
        options: {
          cwd: options.directory,
          resume: resumeId,
          abortController: options.abortController,
          permissionMode: isBypass ? 'bypassPermissions' : 'default',
          ...(isBypass ? { allowDangerouslySkipPermissions: true } : {}),
          model: options.model,
          systemPrompt,
          canUseTool: options.canUseTool,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
        },
      });

      yield* this.translateStream(stream, resumeId, retried, (f, r) => {
        failed = f;
        retried = r;
      });

      // If the stream signalled a retry, the outer values were mutated via callback
      if (failed && !retried) {
        retried = true;
        resumeId = undefined;
        // Signal session ID reset
        yield { type: 'session_init', providerSessionId: '' };
        continue;
      }
      break;
    }
  }

  async *continueSession(options: ProviderSessionOptions): AsyncGenerator<ProviderEvent> {
    const systemPrompt = buildClaudeSystemPrompt(options.systemPromptParts);
    const isBypass = options.claudePermissionMode === 'bypass';

    let retried = false;
    let resumeId = options.providerSessionId;

    while (true) {
      let failed = false;
      const stream = query({
        prompt: '',
        options: {
          cwd: options.directory,
          ...(resumeId ? { continue: true, resume: resumeId } : {}),
          abortController: options.abortController,
          permissionMode: isBypass ? 'bypassPermissions' : 'default',
          ...(isBypass ? { allowDangerouslySkipPermissions: true } : {}),
          model: options.model,
          systemPrompt,
          canUseTool: options.canUseTool,
          includePartialMessages: true,
          settingSources: ['user', 'project', 'local'],
        },
      });

      yield* this.translateStream(stream, resumeId, retried, (f, r) => {
        failed = f;
        retried = r;
      });

      if (failed && !retried) {
        retried = true;
        resumeId = undefined;
        yield { type: 'session_init', providerSessionId: '' };
        continue;
      }
      break;
    }
  }

  private async *translateStream(
    stream: AsyncGenerator<SDKMessage>,
    resumeId: string | undefined,
    alreadyRetried: boolean,
    setRetry: (failed: boolean, retried: boolean) => void,
  ): AsyncGenerator<ProviderEvent> {
    let currentToolName: string | null = null;
    let currentToolInput = '';

    for await (const message of stream) {
      // Capture session ID from init message
      if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
        const initMessage = message as ClaudeSystemMessage;
        yield { type: 'session_init', providerSessionId: initMessage.session_id || '' };
      }

      if (message.type === 'stream_event') {
        const event = (message as { event?: ClaudeStreamEvent }).event;

        if (event?.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolName = event.content_block.name || 'tool';
            currentToolInput = '';
          }
        }

        if (event?.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text_delta', text: event.delta.text };
          }
          if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            currentToolInput += event.delta.partial_json;
          }
        }

        if (event?.type === 'content_block_stop') {
          if (currentToolName) {
            // AskUserQuestion → special event
            if (currentToolName === 'AskUserQuestion') {
              yield { type: 'ask_user', questionsJson: currentToolInput };
            }
            // Task tools → task event
            else if (TASK_TOOLS.has(currentToolName)) {
              yield { type: 'task', action: currentToolName, dataJson: currentToolInput };
            }
            // All other tools → tool_start
            else {
              yield { type: 'tool_start', toolName: currentToolName, toolInput: currentToolInput };
            }

            // Check if an image file was written/read
            const imagePath = extractImagePath(currentToolName, currentToolInput);
            if (imagePath) {
              yield { type: 'image_file', filePath: imagePath };
            }

            currentToolName = null;
            currentToolInput = '';
          }
        }
      }

      // Tool results (user messages containing tool_result blocks)
      if (message.type === 'user') {
        const content = (message as ClaudeUserMessage).message?.content;
        let resultText = '';
        const toolName = '';
        if (Array.isArray(content)) {
          for (const rawBlock of content) {
            const block = rawBlock as { type?: string; content?: unknown };
            if (block.type === 'tool_result' && block.content) {
              if (typeof block.content === 'string') {
                resultText += block.content;
              } else if (Array.isArray(block.content)) {
                for (const sub of block.content as Array<{ type?: string; text?: string }>) {
                  if (sub.type === 'text' && sub.text) resultText += sub.text;
                }
              }
            }
          }
        }
        if (resultText) {
          yield { type: 'tool_result', toolName, result: resultText };
        }
      }

      // Task lifecycle messages (internal subagents spawned by Claude)
      if (message.type === 'system') {
        const systemMessage = message as ClaudeSystemMessage;
        const sub = systemMessage.subtype;
        if (sub === 'task_started') {
          yield {
            type: 'task_started',
            taskId: systemMessage.task_id || '',
            description: systemMessage.description || '',
          };
        } else if (sub === 'task_progress') {
          yield {
            type: 'task_progress',
            taskId: systemMessage.task_id || '',
            description: systemMessage.description || '',
            lastToolName: systemMessage.last_tool_name,
            summary: systemMessage.summary,
          };
        } else if (sub === 'task_notification') {
          yield {
            type: 'task_done',
            taskId: systemMessage.task_id || '',
            status:
              (systemMessage.status as 'completed' | 'failed' | 'stopped' | undefined) ||
              'completed',
            summary: systemMessage.summary || '',
          };
        }
      }

      // Result message
      if (message.type === 'result') {
        const r = message as ClaudeResultMessage;

        // Detect failure that should trigger retry
        if (r.subtype !== 'success' && !alreadyRetried && resumeId) {
          setRetry(true, false);
          break;
        }

        yield {
          type: 'result',
          success: r.subtype === 'success',
          costUsd: r.total_cost_usd ?? 0,
          durationMs: r.duration_ms ?? 0,
          numTurns: r.num_turns ?? 0,
          errors: r.errors ?? [],
          terminalReason: mapClaudeTerminalReason(r.terminal_reason) ?? (r.subtype === 'success' ? 'completed' : 'error'),
        };
      }
    }
  }
}
