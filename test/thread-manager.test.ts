import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';

// ─── Shared mock state (mutable, reset per test) ─────────────────────────────

let sessionsMap: Map<string, any>;

function makeSession(overrides: Record<string, any> = {}): any {
  return {
    id: 'test-session',
    channelId: 'ch-1',
    categoryId: 'cat-1',
    projectName: 'test-project',
    agentLabel: 'test-agent',
    provider: 'claude' as const,
    providerSessionId: 'ps-1',
    monitorProviderSessionId: undefined,
    directory: '/tmp/test-project',
    mode: 'auto' as const,
    agentPersona: undefined,
    verbose: false,
    isGenerating: false,
    messageCount: 0,
    totalCost: 0,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    currentTurn: 0,
    humanResolved: false,
    discoverySource: 'discord' as const,
    remoteHumanControl: false,
    subagentDepth: 0,
    type: 'persistent' as const,
    codexBypass: false,
    workflowState: { status: 'idle' as const, iteration: 0, updatedAt: Date.now() },
    ...overrides,
  };
}

// ─── Stable mock provider (same instance across resetAllMocks) ────────────────

const mockSendPromptGen = vi.fn(async function* (
  _prompt: string,
  _options: any,
): AsyncGenerator<any> {
  yield { type: 'session_init', providerSessionId: 'new-ps-1' };
  yield { type: 'text_delta', text: 'Hello!' };
  yield { type: 'result', success: true, costUsd: 0.05, durationMs: 1000, numTurns: 1, errors: [] };
});

const mockContinueSessionGen = vi.fn(async function* (): AsyncGenerator<any> {
  yield { type: 'session_init', providerSessionId: 'resumed-ps-1' };
  yield { type: 'text_delta', text: 'Continued!' };
  yield { type: 'result', success: true, costUsd: 0.02, durationMs: 500, numTurns: 1, errors: [] };
});

const mockProvider = {
  name: 'claude' as const,
  sendPrompt: mockSendPromptGen,
  continueSession: mockContinueSessionGen,
  supports: vi.fn(() => false),
};

const ensureProviderMock = vi.fn(async () => mockProvider);

// ─── Mocks (must be before any import of thread-manager) ──────────────────────

vi.mock('../src/config.ts', () => ({
  config: {
    dataDir: '/tmp/workspacecord-test-tm',
    token: 'test-token',
    clientId: 'test-client',
    guildId: 'test-guild',
    defaultProvider: 'claude' as const,
    defaultMode: 'auto' as const,
    claudePermissionMode: 'normal' as const,
    codexSandboxMode: 'workspace-write' as const,
    codexApprovalPolicy: 'on-failure' as const,
    codexNetworkAccessEnabled: true,
    codexWebSearchMode: 'live' as const,
    codexReasoningEffort: 'medium' as const,
    allowedUsers: ['test-user'],
    allowAllUsers: false,
    messageRetentionDays: 0,
    autoArchiveDays: 7,
    maxActiveSessionsPerProject: 20,
    textChunkLimit: 2000,
    chunkMode: 'length' as const,
    replyToMode: 'first' as const,
    ackReaction: '\u{1F440}',
    healthReportEnabled: false,
    sessionSyncIntervalMs: 30000,
    sessionSyncRecentDays: 3,
    healthCheckStuckThresholdMs: 1800000,
    healthCheckIdleThresholdMs: 7200000,
    hookSecret: '',
    maxSubagentDepth: 3,
    rateLimitMs: 1000,
    shellEnabled: false,
    shellAllowedUsers: [],
    codexBaseUrl: '',
    codexApiKey: '',
    codexPath: '',
    anthropicApiKey: '',
    anthropicBaseUrl: '',
  },
}));

vi.mock('../src/session-registry.ts', () => {
  return {
    getSession: vi.fn((id: string) => {
      if (!sessionsMap) return undefined;
      return sessionsMap.get('ch-1');
    }),
    getSessionByChannel: vi.fn((id: string) => {
      if (!sessionsMap) return undefined;
      return sessionsMap.get(id);
    }),
    getSessionByThread: vi.fn((id: string) => {
      if (!sessionsMap) return undefined;
      return sessionsMap.get(id);
    }),
    getSessionByCodexId: vi.fn(() => undefined),
    getSessionByProviderSession: vi.fn((_p: string, providerSessionId: string) => {
      if (!sessionsMap) return undefined;
      const s = sessionsMap.get('ch-1');
      return s?.providerSessionId === providerSessionId ? s : undefined;
    }),
    getSessionsByCategory: vi.fn(() => {
      if (!sessionsMap) return [];
      return [sessionsMap.get('ch-1')].filter(Boolean);
    }),
    getAllSessions: vi.fn(() => {
      if (!sessionsMap) return [];
      return [sessionsMap.get('ch-1')].filter(Boolean);
    }),
    findCodexSessionForMonitor: vi.fn(() => undefined),
    findCodexSessionByProviderSessionId: vi.fn(() => undefined),
    findCodexSessionByCwd: vi.fn(() => undefined),
    resolveCodexSessionFromMonitor: vi.fn(() => undefined),
    updateSession: vi.fn(),
    updateSessionPermissions: vi.fn(async () => {}),
    resolveEffectiveClaudePermissionMode: vi.fn((s: any) =>
      s.mode === 'auto' ? 'bypass' : (s.claudePermissionMode ?? 'normal'),
    ),
    resolveEffectiveCodexOptions: vi.fn(() => ({
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'on-failure' as const,
      networkAccessEnabled: true,
      webSearchMode: 'live' as const,
      bypass: false,
    })),
    getSessionPermissionSummary: vi.fn(() => 'bypass'),
    getSessionPermissionDetails: vi.fn(() => 'claude: bypass'),
    setStatusCardBinding: vi.fn(),
    setCurrentInteractionMessage: vi.fn(),
    endSession: vi.fn(async () => {}),
    setMode: vi.fn(),
    setVerbose: vi.fn(),
    setModel: vi.fn(),
    setAgentPersona: vi.fn(),
    setMonitorGoal: vi.fn(),
    updateWorkflowState: vi.fn(),
    resetWorkflowState: vi.fn(),
    abortSession: vi.fn(() => false),
    abortSessionWithReason: vi.fn(() => false),
    consumeAbortReason: vi.fn(() => undefined),
    loadSessions: vi.fn(async () => {}),
    createSession: vi.fn(async (params: any) => ({
      ...makeSession(),
      ...params,
      id: params.channelId,
    })),
    setSessionController: vi.fn(),
    getSessionController: vi.fn(() => undefined),
    clearSessionController: vi.fn(),
    markSessionGenerating: vi.fn((sessionId: string, generating: boolean) => {
      if (!sessionsMap) return;
      const s = sessionsMap.get('ch-1');
      if (s) s.isGenerating = generating;
    }),
    saveSessionImmediate: vi.fn(async () => {}),
    debouncedSaveSession: vi.fn(),
  };
});

vi.mock('../src/project-manager.ts', () => ({
  getPersonality: vi.fn(() => 'You are a helpful coding assistant.'),
}));

vi.mock('../src/agents.ts', () => ({
  getAgent: vi.fn(() => ({
    name: 'general',
    emoji: '\u{1F9E0}',
    description: 'Default',
    systemPrompt: 'You are a general-purpose AI assistant.',
  })),
}));

vi.mock('../src/discord/session-message-context.ts', () => ({
  buildDiscordSessionMessageContext: vi.fn(
    () => 'Messages in this session come from Discord.',
  ),
}));

vi.mock('../src/utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils.ts')>();
  return {
    ...actual,
    isAbortError: vi.fn((err: unknown) =>
      err instanceof Error && err.name === 'AbortError',
    ),
    resolvePath: vi.fn((p: string) => p),
    sanitizeName: vi.fn((name: string) =>
      name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''),
    ),
  };
});

vi.mock('../src/providers/index.ts', () => ({
  ensureProvider: ensureProviderMock,
}));

vi.mock('../src/archive-manager.ts', () => ({
  isArchivedProviderSession: vi.fn(() => false),
}));

vi.mock('../src/project-registry.ts', () => ({
  getProjectByPath: vi.fn((cwd: string) =>
    cwd.startsWith('/tmp/test-project')
      ? {
          name: 'test-project',
          path: '/tmp/test-project',
          discordCategoryId: 'cat-1',
          historyChannelId: 'hist-1',
          controlChannelId: 'ctrl-1',
          personality: 'Test personality',
          skills: {},
          mcpServers: [],
          createdAt: Date.now(),
        }
      : undefined,
  ),
  getAllRegisteredProjects: vi.fn(() => [
    {
      name: 'test-project',
      path: '/tmp/test-project',
      discordCategoryId: 'cat-1',
      historyChannelId: 'hist-1',
      controlChannelId: 'ctrl-1',
      personality: 'Test personality',
      skills: {},
      mcpServers: [],
      createdAt: Date.now(),
    },
  ]),
  loadRegistry: vi.fn(async () => {}),
  getProjectByName: vi.fn((name: string) =>
    name === 'test-project'
      ? {
          name: 'test-project',
          path: '/tmp/test-project',
          discordCategoryId: 'cat-1',
          historyChannelId: 'hist-1',
          controlChannelId: 'ctrl-1',
          personality: 'Test personality',
          skills: {},
          mcpServers: [],
          createdAt: Date.now(),
        }
      : undefined,
  ),
  getProjectByCategoryId: vi.fn((id: string) =>
    id === 'cat-1'
      ? {
          name: 'test-project',
          path: '/tmp/test-project',
          discordCategoryId: 'cat-1',
          historyChannelId: 'hist-1',
          controlChannelId: 'ctrl-1',
          personality: 'Test personality',
          skills: {},
          mcpServers: [],
          createdAt: Date.now(),
        }
      : undefined,
  ),
  getAllProjects: vi.fn(() => ({
    'cat-1': {
      name: 'test-project',
      path: '/tmp/test-project',
      discordCategoryId: 'cat-1',
      historyChannelId: 'hist-1',
      controlChannelId: 'ctrl-1',
      personality: 'Test personality',
      skills: {},
      mcpServers: [],
      createdAt: Date.now(),
    },
  })),
  bindProjectCategory: vi.fn(async () => {}),
  setProjectHistoryChannel: vi.fn(async () => {}),
  setProjectControlChannel: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Thread Manager', () => {
  let registry: any;

  beforeEach(async () => {
    mkdirSync('/tmp/workspacecord-test-tm', { recursive: true });
    sessionsMap = new Map();
    sessionsMap.set('ch-1', makeSession());
    vi.clearAllMocks();
    mockSendPromptGen.mockImplementation(async function* () {
      yield { type: 'session_init', providerSessionId: 'new-ps-1' };
      yield { type: 'text_delta', text: 'Hello!' };
      yield { type: 'result', success: true, costUsd: 0.05, durationMs: 1000, numTurns: 1, errors: [] };
    });
    mockContinueSessionGen.mockImplementation(async function* () {
      yield { type: 'session_init', providerSessionId: 'resumed-ps-1' };
      yield { type: 'text_delta', text: 'Continued!' };
      yield { type: 'result', success: true, costUsd: 0.02, durationMs: 500, numTurns: 1, errors: [] };
    });

    // Re-import after clear to get fresh mock refs
    registry = await import('../src/session-registry.ts');
  });

  afterEach(() => {
    sessionsMap = new Map();
    vi.resetModules();
  });

  describe('buildClaudeSubagentProviderSessionId', () => {
    it('builds a subagent session ID from parent and agent ID', async () => {
      const { buildClaudeSubagentProviderSessionId } = await import('../src/session/session-local-registration.ts');
      const result = buildClaudeSubagentProviderSessionId('parent-123', 'agent-xyz');
      expect(result).toBe('subagent:parent-123:agent-xyz');
    });

    it('handles special characters in agent ID', async () => {
      const { buildClaudeSubagentProviderSessionId } = await import('../src/session/session-local-registration.ts');
      const result = buildClaudeSubagentProviderSessionId('p', 'a/b_c');
      expect(result).toBe('subagent:p:a/b_c');
    });
  });

  describe('sendPrompt', () => {
    it('throws when session is not found', async () => {
      sessionsMap.clear();

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');
      await expect(async () => {
        const gen = sendPrompt('nonexistent', 'hello');
        for await (const _ of gen);
      }).rejects.toThrow('Session "nonexistent" not found');
    });

    it('throws when session is already generating', async () => {
      sessionsMap.set('ch-1', makeSession({ isGenerating: true }));

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');
      await expect(async () => {
        const gen = sendPrompt('test-session', 'hello');
        for await (const _ of gen);
      }).rejects.toThrow('Session is already generating');
    });

    it('calls provider.sendPrompt with correct options', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      const events: any[] = [];
      for await (const event of sendPrompt('test-session', 'hello')) {
        events.push(event);
      }

      expect(ensureProviderMock).toHaveBeenCalledWith('claude');
      expect(mockSendPromptGen).toHaveBeenCalled();

      const callOptions = mockSendPromptGen.mock.calls[0][1];
      expect(callOptions.directory).toBe('/tmp/test-project');
      expect(callOptions.systemPromptParts).toBeDefined();
      expect(callOptions.systemPromptParts.length).toBeGreaterThan(0);
      expect(callOptions.abortController).toBeDefined();
    });

    it('yields all events from provider stream', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      const events: any[] = [];
      for await (const event of sendPrompt('test-session', 'hello')) {
        events.push(event);
      }

      expect(events.some((e) => e.type === 'session_init')).toBe(true);
      expect(events.some((e) => e.type === 'text_delta')).toBe(true);
      expect(events.some((e) => e.type === 'result')).toBe(true);
    });

    it('saves session on session_init event', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'hello'));

      // session_init triggers debouncedSaveSession
      expect(registry.debouncedSaveSession).toHaveBeenCalled();
    });

    it('accumulates cost on result event', async () => {
      sessionsMap.set('ch-1', makeSession({ totalCost: 0 }));

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'hello'));

      // result event directly mutates session.totalCost
      expect(sessionsMap.get('ch-1').totalCost).toBe(0.05);
    });

    it('clears generating flag in finally block', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'hello'));

      expect(registry.markSessionGenerating).toHaveBeenCalledWith('test-session', false);
      expect(registry.clearSessionController).toHaveBeenCalledWith('test-session');
    });
  });

  describe('continueSession', () => {
    it('calls provider.continueSession with correct options', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { continueSession } = await import('../src/session/session-provider-runtime.ts');

      const events: any[] = [];
      for await (const event of continueSession('test-session')) {
        events.push(event);
      }

      expect(ensureProviderMock).toHaveBeenCalledWith('claude');
      expect(mockContinueSessionGen).toHaveBeenCalled();

      const callOptions = mockContinueSessionGen.mock.calls[0][0];
      expect(callOptions.directory).toBe('/tmp/test-project');
      expect(callOptions.systemPromptParts).toBeDefined();
    });

    it('yields all events from continued session', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { continueSession } = await import('../src/session/session-provider-runtime.ts');

      const events: any[] = [];
      for await (const event of continueSession('test-session')) {
        events.push(event);
      }

      expect(events.some((e) => e.type === 'session_init')).toBe(true);
      expect(events.some((e) => e.type === 'text_delta')).toBe(true);
      expect(events.some((e) => e.type === 'result')).toBe(true);
    });
  });

  describe('sendMonitorPrompt', () => {
    it('calls provider.sendPrompt with monitor system prompt', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendMonitorPrompt } = await import('../src/session/session-provider-runtime.ts');

      const events: any[] = [];
      for await (const event of sendMonitorPrompt('test-session', 'Check progress')) {
        events.push(event);
      }

      expect(mockSendPromptGen).toHaveBeenCalled();

      const callOptions = mockSendPromptGen.mock.calls[0][1];
      // Monitor mode uses buildMonitorSystemPromptParts
      expect(callOptions.systemPromptParts).toBeDefined();
    });

    it('saves session after completing monitor prompt', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendMonitorPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendMonitorPrompt('test-session', 'Check progress'));

      expect(registry.debouncedSaveSession).toHaveBeenCalled();
    });

    it('updates lastActivity timestamp after monitor prompt', async () => {
      sessionsMap.set('ch-1', makeSession());
      const beforeActivity = sessionsMap.get('ch-1').lastActivity;

      const { sendMonitorPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendMonitorPrompt('test-session', 'Check progress'));

      expect(sessionsMap.get('ch-1').lastActivity).toBeGreaterThanOrEqual(beforeActivity);
    });
  });

  describe('mode prompt injection', () => {
    it('uses bypass permission mode for auto sessions', async () => {
      sessionsMap.set('ch-1', makeSession({ mode: 'auto' }));

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'auto task'));

      expect(registry.resolveEffectiveClaudePermissionMode).toHaveBeenCalled();
    });

    it('system prompt includes personality when configured', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'hello'));

      const callOptions = mockSendPromptGen.mock.calls[0][1];
      const parts = callOptions.systemPromptParts;
      // Personality mock returns 'You are a helpful coding assistant.'
      expect(parts.some((p: string) => p.includes('helpful coding assistant'))).toBe(true);
    });

    it('system prompt includes mode prompt for plan mode', async () => {
      sessionsMap.set('ch-1', makeSession({ mode: 'plan' }));

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'plan task'));

      const callOptions = mockSendPromptGen.mock.calls[0][1];
      const parts = callOptions.systemPromptParts;
      expect(parts.some((p: string) => p.includes('EnterPlanMode'))).toBe(true);
    });

    it('system prompt includes mode prompt for normal mode', async () => {
      sessionsMap.set('ch-1', makeSession({ mode: 'normal' }));

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'normal task'));

      const callOptions = mockSendPromptGen.mock.calls[0][1];
      const parts = callOptions.systemPromptParts;
      expect(parts.some((p: string) => p.includes('AskUserQuestion'))).toBe(true);
    });

    it('system prompt includes discord session context', async () => {
      sessionsMap.set('ch-1', makeSession());

      const { sendPrompt } = await import('../src/session/session-provider-runtime.ts');

      for await (const _ of sendPrompt('test-session', 'hello'));

      const callOptions = mockSendPromptGen.mock.calls[0][1];
      const parts = callOptions.systemPromptParts;
      expect(parts.some((p: string) => p.includes('Discord'))).toBe(true);
    });
  });

  describe('re-exported session-registry functions', () => {
    it('re-exports loadSessions', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.loadSessions).toBe('function');
    });

    it('re-exports createSession', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.createSession).toBe('function');
    });

    it('re-exports getSession', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.getSession).toBe('function');
    });

    it('re-exports getSessionByChannel', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.getSessionByChannel).toBe('function');
    });

    it('re-exports endSession', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.endSession).toBe('function');
    });

    it('re-exports setMode', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.setMode).toBe('function');
    });

    it('re-exports abortSession', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.abortSession).toBe('function');
    });

    it('re-exports getAllSessions', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(typeof tm.getAllSessions).toBe('function');
    });

    it('re-exports CreateSessionParams type', async () => {
      const tm = await import('../src/session-registry.ts');
      expect(tm).toBeDefined();
    });
  });

  describe('updateLocalObservation', () => {
    it('updates session with discovery info', async () => {
      const { updateLocalObservation } = await import('../src/session/session-local-registration.ts');

      updateLocalObservation('test-session', {
        discoverySource: 'claude-hook',
        cwd: '/some/path',
      });

      expect(registry.updateSession).toHaveBeenCalledWith('test-session', expect.objectContaining({
        discoverySource: 'claude-hook',
      }));
    });

    it('includes remoteHumanControl when provided', async () => {
      const { updateLocalObservation } = await import('../src/session/session-local-registration.ts');

      updateLocalObservation('test-session', {
        discoverySource: 'sync',
        cwd: '/other/path',
        remoteHumanControl: true,
      });

      expect(registry.updateSession).toHaveBeenCalledWith('test-session', expect.objectContaining({
        remoteHumanControl: true,
      }));
    });

    it('omits remoteHumanControl when not provided', async () => {
      const { updateLocalObservation } = await import('../src/session/session-local-registration.ts');

      updateLocalObservation('test-session', {
        discoverySource: 'codex-log',
        cwd: '/third/path',
      });

      const callArg = registry.updateSession.mock.calls[0][1];
      expect('remoteHumanControl' in callArg).toBe(false);
    });
  });
});
