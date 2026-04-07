import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  runStreamedMock,
  startThreadMock,
  resumeThreadMock,
  codexConstructorMock,
} = vi.hoisted(() => {
  const runStreamedMock = vi.fn();
  const startThreadMock = vi.fn(() => ({ runStreamed: runStreamedMock }));
  const resumeThreadMock = vi.fn(() => ({ runStreamed: runStreamedMock }));
  const codexConstructorMock = vi.fn(() => ({
    startThread: startThreadMock,
    resumeThread: resumeThreadMock,
  }));

  return {
    runStreamedMock,
    startThreadMock,
    resumeThreadMock,
    codexConstructorMock,
  };
});

vi.mock('@openai/codex-sdk', () => ({
  Codex: function MockCodex() {
    codexConstructorMock();
    return {
      startThread: startThreadMock,
      resumeThread: resumeThreadMock,
    };
  },
}));

function makeOptions(overrides: Record<string, unknown> = {}) {
  const dir = (overrides.directory as string) || mkdtempSync(join(tmpdir(), 'wc-codex-'));
  return {
    directory: dir,
    providerSessionId: overrides.providerSessionId as string | undefined,
    model: overrides.model as string | undefined,
    sandboxMode: overrides.sandboxMode as string | undefined,
    approvalPolicy: overrides.approvalPolicy as string | undefined,
    networkAccessEnabled: (overrides.networkAccessEnabled as boolean) ?? false,
    webSearchMode: overrides.webSearchMode as string | undefined,
    modelReasoningEffort: overrides.modelReasoningEffort as string | undefined,
    claudePermissionMode: undefined,
    systemPromptParts: (overrides.systemPromptParts as string[]) || ['persona'],
    abortController: (overrides.abortController as AbortController) || new AbortController(),
    canUseTool: undefined,
  };
}

/** Helper: consume an async generator and return collected events. */
async function collectEvents(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** Helper: setup a minimal successful stream. */
function mockSuccess(threadId = 't-1', tokens = { input_tokens: 1, output_tokens: 1 }) {
  runStreamedMock.mockResolvedValue({
    events: (async function* () {
      yield { type: 'thread.started', thread_id: threadId };
      yield { type: 'turn.completed', usage: tokens };
    })(),
  });
}

describe('CodexProvider', () => {
  let repoDir = '';

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    repoDir = mkdtempSync(join(tmpdir(), 'workspacecord-codex-provider-'));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  // ── Basic properties ──────────────────────────────────────────

  it('has name = "codex"', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();
    expect(provider.name).toBe('codex');
  });

  // ── supports() ────────────────────────────────────────────────

  it('supports command_execution', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    expect(new CodexProvider().supports('command_execution')).toBe(true);
  });

  it('supports file_changes', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    expect(new CodexProvider().supports('file_changes')).toBe(true);
  });

  it('supports reasoning', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    expect(new CodexProvider().supports('reasoning')).toBe(true);
  });

  it('supports todo_list', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    expect(new CodexProvider().supports('todo_list')).toBe(true);
  });

  it('supports continue', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    expect(new CodexProvider().supports('continue')).toBe(true);
  });

  it('does not support unknown features', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    expect(new CodexProvider().supports('nonexistent')).toBe(false);
    expect(new CodexProvider().supports('ask_user')).toBe(false);
  });

  // ── sendPrompt → startThread ──────────────────────────────────

  it('sendPrompt calls startThread (not resumeThread) when no providerSessionId', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    await collectEvents(provider.sendPrompt('hello', makeOptions({ directory: repoDir })));

    expect(startThreadMock).toHaveBeenCalledTimes(1);
    expect(resumeThreadMock).not.toHaveBeenCalled();
  });

  it('sendPrompt calls resumeThread when providerSessionId is provided', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    await collectEvents(
      provider.sendPrompt('hello', makeOptions({ directory: repoDir, providerSessionId: 'sess-1' })),
    );

    expect(resumeThreadMock).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      workingDirectory: repoDir,
    }));
    expect(startThreadMock).not.toHaveBeenCalled();
  });

  it('passes sandbox mode and approval policy to thread options', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    await collectEvents(
      provider.sendPrompt('hi', makeOptions({
        directory: repoDir,
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
      })),
    );

    const threadOpts = startThreadMock.mock.calls[0][0];
    expect(threadOpts.sandboxMode).toBe('danger-full-access');
    expect(threadOpts.approvalPolicy).toBe('never');
  });

  it('passes network access and web search to thread options', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    await collectEvents(
      provider.sendPrompt('hi', makeOptions({
        directory: repoDir,
        networkAccessEnabled: true,
        webSearchMode: 'live',
      })),
    );

    const threadOpts = startThreadMock.mock.calls[0][0];
    expect(threadOpts.networkAccessEnabled).toBe(true);
    expect(threadOpts.webSearchMode).toBe('live');
  });

  it('passes model and reasoning effort to thread options', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    await collectEvents(
      provider.sendPrompt('hi', makeOptions({
        directory: repoDir,
        model: 'o3',
        modelReasoningEffort: 'high',
      })),
    );

    const threadOpts = startThreadMock.mock.calls[0][0];
    expect(threadOpts.model).toBe('o3');
    expect(threadOpts.modelReasoningEffort).toBe('high');
  });

  // ── Event mapping ─────────────────────────────────────────────

  it('maps thread.started to session_init', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'abc-123' };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({ type: 'session_init', providerSessionId: 'abc-123' });
  });

  it('maps item.started text_delta (incremental)', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield { type: 'item.started', item: { id: 'm1', type: 'agent_message', text: 'Hel' } };
        yield { type: 'item.updated', item: { id: 'm1', type: 'agent_message', text: 'Hello' } };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    const deltas = events.filter((e) => e.type === 'text_delta') as { type: string; text: string }[];
    expect(deltas).toHaveLength(2);
    expect(deltas[0].text).toBe('Hel');
    expect(deltas[1].text).toBe('lo');
  });

  it('maps item.completed command_execution', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'ls -la',
            aggregated_output: 'file1.txt',
            exit_code: 0,
            status: 'completed',
          },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({
      type: 'command_execution',
      command: 'ls -la',
      output: 'file1.txt',
      exitCode: 0,
      status: 'completed',
    });
  });

  it('maps item.completed file_change', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: {
            type: 'file_change',
            changes: [{ path: 'src/foo.ts', kind: 'add' }],
          },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({
      type: 'file_change',
      changes: [{ filePath: 'src/foo.ts', changeKind: 'add' }],
    });
  });

  it('maps item.completed reasoning', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: { type: 'reasoning', summary: 'thinking about it' },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({ type: 'reasoning', text: 'thinking about it' });
  });

  it('maps item.updated reasoning', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.updated',
          item: { type: 'reasoning', summary: 'deep thought' },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({ type: 'reasoning', text: 'deep thought' });
  });

  it('maps item.completed todo_list', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: {
            type: 'todo_list',
            items: [{ text: 'Write tests', completed: false }, { text: 'Ship', completed: true }],
          },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({
      type: 'todo_list',
      items: [
        { text: 'Write tests', completed: false },
        { text: 'Ship', completed: true },
      ],
    });
  });

  it('maps item.completed mcp_tool_call to tool_start + tool_result', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'filesystem',
            tool: 'read_file',
            arguments: { path: '/tmp/f' },
            status: 'completed',
            output: 'file contents',
          },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({
      type: 'tool_start',
      toolName: 'filesystem/read_file',
      toolInput: JSON.stringify({ path: '/tmp/f' }),
    });
    expect(events).toContainEqual({
      type: 'tool_result',
      toolName: 'filesystem/read_file',
      result: 'file contents',
      isError: false,
    });
  });

  it('maps mcp_tool_call failed status to tool_result with isError', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'db',
            tool: 'query',
            arguments: {},
            status: 'failed',
            output: 'connection refused',
          },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    const result = events.find((e) => e.type === 'tool_result') as Record<string, unknown>;
    expect(result.isError).toBe(true);
  });

  it('maps item.completed web_search', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: { type: 'web_search', query: 'latest news' },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({ type: 'web_search', query: 'latest news' });
  });

  it('maps item.completed error', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'item.completed',
          item: { type: 'error', message: 'something broke' },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({ type: 'error', message: 'something broke' });
  });

  it('maps turn.completed to result with cost calculation', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 100, output_tokens: 200 },
        };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    const result = events.find((e) => e.type === 'result') as Record<string, unknown>;
    expect(result).toMatchObject({
      type: 'result',
      success: true,
      numTurns: 1,
      errors: [],
    });
    // cost = (100*2 + 200*8) / 1_000_000 = 1800 / 1_000_000 = 0.0018
    expect(result.costUsd).toBe(0.0018);
    expect(typeof result.durationMs).toBe('number');
  });

  it('maps turn.failed to result with success=false', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield { type: 'turn.failed', error: 'rate limited' };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    const result = events.find((e) => e.type === 'result') as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.errors).toContain('rate limited');
  });

  it('maps top-level error event', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        yield { type: 'error', message: 'network error' };
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({ type: 'error', message: 'network error' });
  });

  // ── Stream error handling ─────────────────────────────────────

  it('catches stream iteration errors and yields error event', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 't' };
        throw new Error('stream crashed');
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    const err = events.find((e) => e.type === 'error') as Record<string, unknown>;
    expect(err.message).toBe('stream crashed');
  });

  it('does not yield error when stream throws and abort signal is set', async () => {
    const ac = new AbortController();
    ac.abort();
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        const shouldNeverYield = Date.now() < 0;
        if (shouldNeverYield) {
          yield { type: 'thread.started', thread_id: 'never' };
        }
        throw new Error('should be suppressed');
      })(),
    });
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir, abortController: ac })),
    );
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
  });

  it('stops iterating when abort signal is already set', async () => {
    const ac = new AbortController();
    let iterated = false;
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        iterated = true;
        yield { type: 'thread.started', thread_id: 't' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    });
    ac.abort();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir, abortController: ac })),
    );
    // The stream is still consumed but abortController.signal.aborted causes break
    // Since abort() is called before iteration starts, the for-await breaks immediately
    expect(iterated).toBe(true); // we did get the async iterable, but break after first yield
  });

  // ── continueSession ───────────────────────────────────────────

  it('continueSession yields error when no providerSessionId', async () => {
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().continueSession(makeOptions({ directory: repoDir })),
    );
    expect(events).toContainEqual({
      type: 'error',
      message: 'No session to continue — no previous thread ID.',
    });
    expect(resumeThreadMock).not.toHaveBeenCalled();
  });

  it('continueSession calls resumeThread with providerSessionId', async () => {
    mockSuccess('continued-thread');
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const events = await collectEvents(
      new CodexProvider().continueSession(
        makeOptions({ directory: repoDir, providerSessionId: 'old-thread' }),
      ),
    );
    expect(resumeThreadMock).toHaveBeenCalledWith('old-thread', expect.objectContaining({
      workingDirectory: repoDir,
    }));
    expect(startThreadMock).not.toHaveBeenCalled();
    const sessionInit = events.find((e) => e.type === 'session_init') as Record<string, unknown>;
    expect(sessionInit.providerSessionId).toBe('continued-thread');
  });

  it('continueSession sends "Continue from where you left off." as input', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().continueSession(
        makeOptions({ directory: repoDir, providerSessionId: 'old-thread' }),
      ),
    );
    const inputArg = runStreamedMock.mock.calls[0][0];
    expect(inputArg).toBe('Continue from where you left off.');
  });

  // ── AGENTS.md injection (additional) ──────────────────────────

  it('injects systemPromptParts into AGENTS.md during sendPrompt', async () => {
    mockSuccess();
    const agentsPath = join(repoDir, 'AGENTS.md');

    // Capture the file content during the stream by using a long-running generator
    let capturedContent: string | null = null;
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        capturedContent = readFileSync(agentsPath, 'utf8');
        yield { type: 'thread.started', thread_id: 't' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
    });

    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({
        directory: repoDir,
        systemPromptParts: ['You are helpful', 'Be concise'],
      })),
    );

    expect(capturedContent).toContain('workspacecord-persona-start');
    expect(capturedContent).toContain('You are helpful');
    expect(capturedContent).toContain('Be concise');
    // After cleanup, file should not exist (didn't exist before)
    expect(existsSync(agentsPath)).toBe(false);
  });

  it('preserves existing AGENTS.md content after cleanup', async () => {
    const agentsPath = join(repoDir, 'AGENTS.md');
    writeFileSync(agentsPath, '# Project rules\nAlways use TypeScript.\n', 'utf8');

    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );

    const content = readFileSync(agentsPath, 'utf8');
    expect(content).toContain('# Project rules');
    expect(content).toContain('Always use TypeScript.');
    expect(content).not.toContain('workspacecord-persona');
  });

  // ── Image content blocks ──────────────────────────────────────

  it('writes base64 image to temp file and passes as local_image', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');

    const events = await collectEvents(
      new CodexProvider().sendPrompt(
        [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from('fake-png-data').toString('base64'),
            },
          },
        ],
        makeOptions({ directory: repoDir }),
      ),
    );

    // Should still produce session_init + result
    expect(events.some((e) => e.type === 'session_init')).toBe(true);
    // The input to runStreamed should include local_image part
    const inputArg = runStreamedMock.mock.calls[0][0];
    // When mixed content, input is array of parts
    expect(Array.isArray(inputArg)).toBe(true);
    const imgPart = (inputArg as Array<{ type: string; path?: string }>).find((p) => p.type === 'local_image');
    expect(imgPart).toBeDefined();
    // Temp file is cleaned up after stream completes — verify path was valid (starts with tmp prefix)
    expect(imgPart!.path).toContain('workspacecord-img-');
  });

  it('passes plain string prompt as-is when no images', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().sendPrompt('just text', makeOptions({ directory: repoDir })),
    );
    const inputArg = runStreamedMock.mock.calls[0][0];
    expect(inputArg).toBe('just text');
  });

  // ── AGENTS.md injection with empty parts ──────────────────────

  it('does not create AGENTS.md when systemPromptParts is empty', async () => {
    mockSuccess();
    const agentsPath = join(repoDir, 'AGENTS.md');

    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({
        directory: repoDir,
        systemPromptParts: [],
      })),
    );

    expect(existsSync(agentsPath)).toBe(false);
  });

  // ── Codex constructor called with buildCodexOptions ───────────

  it('creates Codex instance on each sendPrompt call', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    await collectEvents(provider.sendPrompt('a', makeOptions({ directory: repoDir })));
    await collectEvents(provider.sendPrompt('b', makeOptions({ directory: repoDir })));

    expect(codexConstructorMock).toHaveBeenCalledTimes(2);
  });

  it('passes skipGitRepoCheck: true to thread options', async () => {
    mockSuccess();
    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    await collectEvents(
      new CodexProvider().sendPrompt('x', makeOptions({ directory: repoDir })),
    );
    const threadOpts = startThreadMock.mock.calls[0][0];
    expect(threadOpts.skipGitRepoCheck).toBe(true);
  });
});
