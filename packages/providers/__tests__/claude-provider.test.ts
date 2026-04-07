import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the SDK ──────────────────────────────────────────────────

const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// ── Import after mocking ─────────────────────────────────────────

import { ClaudeProvider } from '../src/claude-provider.ts';
import type { ProviderSessionOptions } from '../src/types.ts';

// ── Helpers ───────────────────────────────────────────────────────

function makeOptions(overrides: Partial<ProviderSessionOptions> = {}): ProviderSessionOptions {
  return {
    directory: '/tmp/test-project',
    systemPromptParts: [],
    abortController: new AbortController(),
    ...overrides,
  };
}

function consumeGenerator<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  return (async () => {
    for await (const item of gen) results.push(item);
    return results;
  })();
}

// ── Tests ─────────────────────────────────────────────────────────

describe('ClaudeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Instantiation & metadata ──────────────────────────────────

  it('instantiates with name = "claude"', () => {
    const provider = new ClaudeProvider();
    expect(provider.name).toBe('claude');
  });

  it('supports resume_from_terminal', () => {
    const provider = new ClaudeProvider();
    expect(provider.supports('resume_from_terminal')).toBe(true);
  });

  it('supports plugins', () => {
    const provider = new ClaudeProvider();
    expect(provider.supports('plugins')).toBe(true);
  });

  it('supports ask_user_question', () => {
    const provider = new ClaudeProvider();
    expect(provider.supports('ask_user_question')).toBe(true);
  });

  it('supports mode_switching', () => {
    const provider = new ClaudeProvider();
    expect(provider.supports('mode_switching')).toBe(true);
  });

  it('supports continue', () => {
    const provider = new ClaudeProvider();
    expect(provider.supports('continue')).toBe(true);
  });

  it('does not support unknown features', () => {
    const provider = new ClaudeProvider();
    expect(provider.supports('nonexistent_feature')).toBe(false);
  });

  // ── sendPrompt: event mapping ─────────────────────────────────

  it('yields session_init when SDK emits system/init', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-abc-123' };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('hello', makeOptions()));

    expect(events[0]).toEqual({ type: 'session_init', providerSessionId: 'sess-abc-123' });
  });

  it('yields text_delta for text_delta events', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('hi', makeOptions()));

    expect(events).toContainEqual({ type: 'text_delta', text: 'Hello world' });
  });

  it('yields tool_start for non-special tools', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
      };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
      };
      yield { type: 'stream_event', event: { type: 'content_block_stop' } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('run ls', makeOptions()));

    expect(events).toContainEqual({ type: 'tool_start', toolName: 'Bash', toolInput: '{"cmd":"ls"}' });
  });

  it('yields ask_user for AskUserQuestion tool', async () => {
    const questionsJson = '[{"question":"Which approach?"}]';
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'AskUserQuestion' } },
      };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: questionsJson } },
      };
      yield { type: 'stream_event', event: { type: 'content_block_stop' } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('ask', makeOptions()));

    expect(events).toContainEqual({ type: 'ask_user', questionsJson });
  });

  it('yields task for TaskCreate tool', async () => {
    const dataJson = '{"subagent_type":"codex"}';
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'TaskCreate' } },
      };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: dataJson } },
      };
      yield { type: 'stream_event', event: { type: 'content_block_stop' } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('delegate', makeOptions()));

    expect(events).toContainEqual({ type: 'task', action: 'TaskCreate', dataJson });
  });

  it('yields tool_result from user message with tool_result block', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: 'command output here',
            },
          ],
        },
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('run', makeOptions()));

    expect(events).toContainEqual({ type: 'tool_result', toolName: '', result: 'command output here' });
  });

  it('yields result with cost tracking on success', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.25,
        duration_ms: 5000,
        num_turns: 3,
      };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('do it', makeOptions()));

    expect(events).toContainEqual({
      type: 'result',
      success: true,
      costUsd: 1.25,
      durationMs: 5000,
      numTurns: 3,
      errors: [],
    });
  });

  it('yields result with errors array', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0,
        duration_ms: 0,
        num_turns: 0,
        errors: ['timeout warning'],
      };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('do it', makeOptions()));

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ errors: ['timeout warning'] });
  });

  it('yields result with success=false for non-success subtype', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'error',
        total_cost_usd: 0.1,
        duration_ms: 200,
        num_turns: 1,
      };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('fail', makeOptions()));

    expect(events).toContainEqual({
      type: 'result',
      success: false,
      costUsd: 0.1,
      durationMs: 200,
      numTurns: 1,
      errors: [],
    });
  });

  // ── System prompt injection ───────────────────────────────────

  it('passes system prompt with preset when parts are empty', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    await consumeGenerator(provider.sendPrompt('hi', makeOptions({ systemPromptParts: [] })));

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('passes system prompt with append when parts are provided', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    await consumeGenerator(
      provider.sendPrompt('hi', makeOptions({ systemPromptParts: ['Be concise', 'Use TypeScript'] })),
    );

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Be concise\n\nUse TypeScript',
    });
  });

  // ── Image detection ───────────────────────────────────────────

  it('yields image_file when Write tool writes an image path', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"/tmp/diagram.png","content":"..."}' },
        },
      };
      yield { type: 'stream_event', event: { type: 'content_block_stop' } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('draw', makeOptions()));

    expect(events).toContainEqual({ type: 'image_file', filePath: '/tmp/diagram.png' });
  });

  it('yields image_file when Read tool reads an image path', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"assets/icon.svg"}' },
        },
      };
      yield { type: 'stream_event', event: { type: 'content_block_stop' } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('read icon', makeOptions()));

    expect(events).toContainEqual({ type: 'image_file', filePath: 'assets/icon.svg' });
  });

  it('does not yield image_file for non-image file paths', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Write' } },
      };
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/index.ts","content":"..."}' },
        },
      };
      yield { type: 'stream_event', event: { type: 'content_block_stop' } };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('write code', makeOptions()));

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'image_file' }));
  });

  // ── Error handling ────────────────────────────────────────────

  it('yields result with defaults when fields are missing', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success' };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('minimal', makeOptions()));

    expect(events).toContainEqual({
      type: 'result',
      success: true,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      errors: [],
    });
  });

  // ── continueSession ───────────────────────────────────────────

  it('continueSession calls query with continue and resume when providerSessionId is set', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    await consumeGenerator(
      provider.continueSession(
        makeOptions({ providerSessionId: 'prev-session-id' }),
      ),
    );

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.continue).toBe(true);
    expect(callArgs.options.resume).toBe('prev-session-id');
    expect(callArgs.prompt).toBe('');
  });

  it('continueSession calls query without continue/resume when no providerSessionId', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    await consumeGenerator(provider.continueSession(makeOptions()));

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.continue).toBeUndefined();
    expect(callArgs.options.resume).toBeUndefined();
  });

  // ── AbortController integration ───────────────────────────────

  it('passes abortController to query options', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const ac = new AbortController();
    const provider = new ClaudeProvider();
    await consumeGenerator(provider.sendPrompt('abort test', makeOptions({ abortController: ac })));

    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.abortController).toBe(ac);
  });

  // ── sendPrompt with ContentBlock array ────────────────────────

  it('sends ContentBlock array as async iterable user message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const blocks = [
      { type: 'text' as const, text: 'Look at this' },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'base64data' },
      },
    ];
    await consumeGenerator(provider.sendPrompt(blocks, makeOptions()));

    const callArgs = mockQuery.mock.calls[0][0];
    // prompt should be an async iterable, not a string
    expect(typeof callArgs.prompt).not.toBe('string');
    expect(typeof (callArgs.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe('function');
  });

  it('filters out LocalImageBlock from content blocks', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const blocks = [
      { type: 'text' as const, text: 'See' },
      { type: 'local_image' as const, path: '/tmp/screenshot.png' },
    ];
    await consumeGenerator(provider.sendPrompt(blocks, makeOptions()));

    const callArgs = mockQuery.mock.calls[0][0];
    // Consume the async iterable to inspect what was yielded
    const userMessage: { message: { content: unknown[] } } = await (async () => {
      for await (const msg of callArgs.prompt as AsyncIterable<unknown>) return msg as { message: { content: unknown[] } };
    })();
    // Only the text block should remain
    expect(userMessage.message.content).toHaveLength(1);
    expect(userMessage.message.content[0]).toEqual({ type: 'text', text: 'See' });
  });

  // ── Task lifecycle messages ───────────────────────────────────

  it('yields task_started from system message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'task_started', task_id: 't1', description: 'Research task' };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('task', makeOptions()));

    expect(events).toContainEqual({
      type: 'task_started',
      taskId: 't1',
      description: 'Research task',
    });
  });

  it('yields task_progress from system message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'system',
        subtype: 'task_progress',
        task_id: 't1',
        description: 'Research',
        last_tool_name: 'Grep',
        summary: 'Searching files',
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('task', makeOptions()));

    expect(events).toContainEqual({
      type: 'task_progress',
      taskId: 't1',
      description: 'Research',
      lastToolName: 'Grep',
      summary: 'Searching files',
    });
  });

  it('yields task_done from system message', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'system',
        subtype: 'task_notification',
        task_id: 't1',
        status: 'completed',
        summary: 'Done',
      };
      yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 0 };
    });

    const provider = new ClaudeProvider();
    const events = await consumeGenerator(provider.sendPrompt('task', makeOptions()));

    expect(events).toContainEqual({
      type: 'task_done',
      taskId: 't1',
      status: 'completed',
      summary: 'Done',
    });
  });
});
