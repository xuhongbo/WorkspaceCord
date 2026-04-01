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

function makeOptions(directory: string) {
  return {
    directory,
    providerSessionId: undefined,
    model: undefined,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'on-failure' as const,
    networkAccessEnabled: false,
    webSearchMode: 'disabled' as const,
    modelReasoningEffort: undefined,
    claudePermissionMode: undefined,
    systemPromptParts: ['session persona prompt'],
    abortController: new AbortController(),
    canUseTool: undefined,
  };
}

describe('codex-provider AGENTS.md 注入清理', () => {
  let repoDir = '';

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    repoDir = mkdtempSync(join(tmpdir(), 'workspacecord-codex-provider-'));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('原本不存在 AGENTS.md 时，结束后会移除注入文件', async () => {
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        yield { type: 'thread.started', thread_id: 'thread-1' };
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })(),
    });

    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    const receivedTypes: string[] = [];
    for await (const event of provider.sendPrompt('hello', makeOptions(repoDir))) {
      receivedTypes.push(event.type);
    }

    expect(receivedTypes).toContain('session_init');
    expect(existsSync(join(repoDir, 'AGENTS.md'))).toBe(false);
  });

  it('结束时只移除自身注入块，不回滚会话期间的外部修改', async () => {
    const agentsPath = join(repoDir, 'AGENTS.md');
    writeFileSync(agentsPath, '# existing instructions\n', 'utf8');

    let releaseStream!: () => void;
    runStreamedMock.mockResolvedValue({
      events: (async function* () {
        const waitForRelease = new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        yield { type: 'thread.started', thread_id: 'thread-1' };
        await waitForRelease;
        yield {
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })(),
    });

    const { CodexProvider } = await import('../src/providers/codex-provider.ts');
    const provider = new CodexProvider();

    const stream = provider.sendPrompt('hello', makeOptions(repoDir));
    const firstEvent = await stream.next();
    expect(firstEvent.value?.type).toBe('session_init');

    const injected = readFileSync(agentsPath, 'utf8');
    expect(injected).toContain('workspacecord-persona-start');
    expect(injected).toContain('session persona prompt');

    writeFileSync(agentsPath, `${injected}\nexternal change\n`, 'utf8');
    releaseStream();

    for await (const _event of stream) {
      // 消耗剩余事件，触发 finally 清理
    }

    const finalContent = readFileSync(agentsPath, 'utf8');
    expect(finalContent).toContain('# existing instructions');
    expect(finalContent).toContain('external change');
    expect(finalContent).not.toContain('workspacecord-persona-start');
    expect(finalContent).not.toContain('session persona prompt');
  });
});
