import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    codexSandboxMode: 'workspace-write' as const,
    codexApprovalPolicy: 'on-failure' as const,
    codexNetworkAccessEnabled: true,
    codexWebSearchMode: 'live' as const,
    codexReasoningEffort: '' as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | '',
    claudePermissionMode: 'normal' as const,
    monitorReasoningEffort: 'high' as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | '',
    monitorClaudeModel: 'claude-opus-4-7',
  },
}));

vi.mock('@workspacecord/providers', () => ({
  ensureProvider: vi.fn(),
}));

vi.mock('@workspacecord/core', async () => {
  const actual = await vi.importActual<typeof import('@workspacecord/core')>(
    '@workspacecord/core',
  );
  return { ...actual, config: mockConfig };
});

vi.mock('../src/session-registry.ts', () => ({
  resolveEffectiveCodexOptions: () => ({
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-failure',
    networkAccessEnabled: true,
    webSearchMode: 'live',
  }),
  resolveEffectiveClaudePermissionMode: () => 'normal',
  setSessionController: vi.fn(),
  clearSessionController: vi.fn(),
  markSessionGenerating: vi.fn(),
  debouncedSaveSession: vi.fn(),
  saveSessionImmediate: vi.fn(),
  getSessionController: vi.fn(),
}));

vi.mock('../src/session-context.ts', () => ({
  getSessionContext: vi.fn(),
}));

vi.mock('../src/session/prompt-assembler.ts', () => ({
  buildSystemPromptParts: () => ['worker prompt'],
  buildMonitorSystemPromptParts: () => ['monitor prompt'],
}));

import { buildProviderOptions } from '../src/session/provider-runtime.ts';
import type { ThreadSession } from '@workspacecord/core';

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    id: 's1',
    channelId: 'c1',
    categoryId: 'cat1',
    projectName: 'p1',
    agentLabel: 'test',
    provider: 'claude',
    type: 'persistent',
    subagentDepth: 0,
    directory: '/tmp',
    mode: 'monitor',
    verbose: false,
    workflowState: { iteration: 0 } as ThreadSession['workflowState'],
    createdAt: 0,
    lastActivity: 0,
    messageCount: 0,
    totalCost: 0,
    currentTurn: 0,
    humanResolved: false,
    isGenerating: false,
    model: 'claude-sonnet-4-6',
    providerSessionId: 'worker-sid',
    monitorProviderSessionId: 'monitor-sid',
    ...overrides,
  } as ThreadSession;
}

describe('buildProviderOptions — Monitor effort integration', () => {
  beforeEach(() => {
    mockConfig.monitorReasoningEffort = 'high';
    mockConfig.monitorClaudeModel = 'claude-opus-4-7';
    mockConfig.codexReasoningEffort = '';
  });

  it('worker pass (isMonitor=false) preserves session.model and ignores monitorEffort', () => {
    const opts = buildProviderOptions(makeSession(), new AbortController(), false);
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.modelReasoningEffort).toBeUndefined();
    expect(opts.providerSessionId).toBe('worker-sid');
  });

  it('monitor pass on Claude with high effort upgrades to monitorClaudeModel', () => {
    mockConfig.monitorReasoningEffort = 'high';
    const opts = buildProviderOptions(makeSession(), new AbortController(), true);
    expect(opts.model).toBe('claude-opus-4-7');
    expect(opts.modelReasoningEffort).toBe('high');
    expect(opts.providerSessionId).toBe('monitor-sid');
  });

  it('monitor pass on Claude with xhigh effort upgrades to monitorClaudeModel', () => {
    mockConfig.monitorReasoningEffort = 'xhigh';
    const opts = buildProviderOptions(makeSession(), new AbortController(), true);
    expect(opts.model).toBe('claude-opus-4-7');
    expect(opts.modelReasoningEffort).toBe('xhigh');
  });

  it('monitor pass on Claude with medium effort keeps session.model', () => {
    mockConfig.monitorReasoningEffort = 'medium';
    const opts = buildProviderOptions(makeSession(), new AbortController(), true);
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.modelReasoningEffort).toBe('medium');
  });

  it('monitor pass on Claude with empty effort falls back to worker codex effort', () => {
    mockConfig.monitorReasoningEffort = '';
    mockConfig.codexReasoningEffort = 'medium';
    const opts = buildProviderOptions(makeSession(), new AbortController(), true);
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.modelReasoningEffort).toBe('medium');
  });

  it('monitor pass on Codex forwards monitorEffort to modelReasoningEffort', () => {
    mockConfig.monitorReasoningEffort = 'high';
    const opts = buildProviderOptions(
      makeSession({ provider: 'codex' }),
      new AbortController(),
      true,
    );
    expect(opts.model).toBe('claude-sonnet-4-6');
    expect(opts.modelReasoningEffort).toBe('high');
  });

  it('falls back to session.model when monitorClaudeModel config is empty', () => {
    mockConfig.monitorReasoningEffort = 'high';
    mockConfig.monitorClaudeModel = '';
    const opts = buildProviderOptions(makeSession(), new AbortController(), true);
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('monitor pass uses buildMonitorSystemPromptParts', () => {
    const opts = buildProviderOptions(makeSession(), new AbortController(), true);
    expect(opts.systemPromptParts).toEqual(['monitor prompt']);
  });

  it('worker pass uses buildSystemPromptParts', () => {
    const opts = buildProviderOptions(makeSession(), new AbortController(), false);
    expect(opts.systemPromptParts).toEqual(['worker prompt']);
  });
});
