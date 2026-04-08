import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sendPromptMock = vi.fn();
const continueSessionMock = vi.fn();
const supportsMock = vi.fn(() => true);
const ensureProviderMock = vi.fn(async () => ({
  name: 'codex',
  sendPrompt: sendPromptMock,
  continueSession: continueSessionMock,
  supports: supportsMock,
}));

vi.mock('@workspacecord/providers', () => ({
  ensureProvider: ensureProviderMock,
}));

vi.mock('../src/agents.ts', () => ({
  getAgent: vi.fn(() => undefined),
}));

vi.mock('../src/project-manager.ts', () => ({
  getPersonality: vi.fn(() => undefined),
}));

vi.mock('@workspacecord/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspacecord/core')>();
  return {
    ...actual,
    config: {
      defaultMode: 'auto',
      codexSandboxMode: 'workspace-write',
      codexApprovalPolicy: 'on-failure',
      codexNetworkAccessEnabled: true,
      codexWebSearchMode: 'live',
      codexReasoningEffort: '',
      claudePermissionMode: 'normal',
    },
  };
});

describe('thread-manager system prompt', () => {
  let dataDir = '';
  let workDir = '';

  beforeEach(() => {
    vi.resetModules();
    sendPromptMock.mockReset();
    sendPromptMock.mockImplementation(async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    });
    dataDir = mkdtempSync(join(tmpdir(), 'workspacecord-system-prompt-data-'));
    workDir = mkdtempSync(join(tmpdir(), 'workspacecord-system-prompt-work-'));
  });

  afterEach(async () => {
    const { _setDataDirForTest } = await import('@workspacecord/core');
    _setDataDirForTest(null);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('engine 层 systemPromptParts 不含 discord 特定内容（已移至 bot 层）', async () => {
    const { _setDataDirForTest } = await import('@workspacecord/core');
    _setDataDirForTest(dataDir);
    const sessionRegistry = await import('../src/session-registry.ts');
    const sessionRuntime = await import('../src/session/provider-runtime.ts');

    const session = await sessionRegistry.createSession({
      channelId: 'channel-1',
      categoryId: 'category-1',
      projectName: 'demo',
      agentLabel: 'demo-session',
      provider: 'codex',
      directory: workDir,
      type: 'persistent',
    });

    for await (const _event of sessionRuntime.sendPrompt(session.id, 'hello')) {
      // consume stream
    }

    expect(sendPromptMock).toHaveBeenCalled();
    const options = sendPromptMock.mock.calls.at(-1)?.[1];
    const promptText = String(options?.systemPromptParts?.join('\n') ?? '');
    // Discord 特定内容已迁至 bot 层的 buildDiscordSessionMessageContext()
    expect(promptText).not.toContain('附件默认不自动下载');
  });

  it('monitor 模式 systemPromptParts 不含 discord 特定内容', async () => {
    const { _setDataDirForTest } = await import('@workspacecord/core');
    _setDataDirForTest(dataDir);
    const sessionRegistry = await import('../src/session-registry.ts');
    const sessionRuntime = await import('../src/session/provider-runtime.ts');

    const session = await sessionRegistry.createSession({
      channelId: 'channel-2',
      categoryId: 'category-1',
      projectName: 'demo',
      agentLabel: 'monitor-session',
      provider: 'codex',
      directory: workDir,
      type: 'persistent',
      mode: 'monitor',
    });

    for await (const _event of sessionRuntime.sendPrompt(session.id, 'hello monitor')) {
      // consume stream
    }

    const options = sendPromptMock.mock.calls.at(-1)?.[1];
    const promptText = String(options?.systemPromptParts?.join('\n') ?? '');
    expect(promptText).not.toContain('附件默认不自动下载');
  });

  it('codex 会话级权限会覆盖默认 provider 选项，bypass 会强制全开', async () => {
    const { _setDataDirForTest } = await import('@workspacecord/core');
    _setDataDirForTest(dataDir);
    const sessionRegistry = await import('../src/session-registry.ts');
    const sessionRuntime = await import('../src/session/provider-runtime.ts');

    const session = await sessionRegistry.createSession({
      channelId: 'channel-3',
      categoryId: 'category-1',
      projectName: 'demo',
      agentLabel: 'permission-session',
      provider: 'codex',
      directory: workDir,
      type: 'persistent',
      codexSandboxMode: 'read-only',
      codexApprovalPolicy: 'untrusted',
      codexBypass: true,
      codexNetworkAccessEnabled: false,
      codexWebSearchMode: 'disabled',
    });

    for await (const _event of sessionRuntime.sendPrompt(session.id, 'hello permissions')) {
      // consume stream
    }

    const options = sendPromptMock.mock.calls.at(-1)?.[1];
    expect(options?.sandboxMode).toBe('danger-full-access');
    expect(options?.approvalPolicy).toBe('never');
    expect(options?.networkAccessEnabled).toBe(true);
    expect(options?.webSearchMode).toBe('live');
  });

});
