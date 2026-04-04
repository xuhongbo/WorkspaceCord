import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock persistence Store
vi.mock('../src/persistence.ts', () => ({
  Store: class {
    private data: any[] = [];
    async read() { return this.data.length ? this.data : null; }
    async write(d: any[]) { this.data = d; return Promise.resolve(); }
  },
  _setDataDirForTest: () => {},
}));

// Mock config
vi.mock('../src/config.ts', () => ({
  config: {
    allowedUsers: [],
    allowAllUsers: true,
    defaultMode: 'auto' as const,
    defaultProvider: 'codex' as const,
    claudePermissionMode: 'normal' as const,
    codexSandboxMode: 'workspace-write' as const,
    codexApprovalPolicy: 'on-failure' as const,
    codexNetworkAccessEnabled: true,
    codexWebSearchMode: 'live' as const,
  },
}));

// Mock utils to avoid filesystem checks
vi.mock('../src/utils.ts', () => ({
  sanitizeName: (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'session';
  },
  resolvePath: (p: string) => p.startsWith('/') ? p : `/tmp/${p}`,
}));

import {
  createSession,
  getSession,
  getSessionByChannel,
  getSessionsByCategory,
  getAllSessions,
  updateSession,
  endSession,
  setMode,
  setVerbose,
  setModel,
  setAgentPersona,
  abortSession,
  abortSessionWithReason,
  consumeAbortReason,
  setSessionController,
  getSessionController,
  clearSessionController,
  markSessionGenerating,
  setMonitorGoal,
  updateWorkflowState,
  resetWorkflowState,
  findCodexSessionForMonitor,
  getSessionByProviderSession,
  getSessionByCodexId,
  updateSessionPermissions,
  resolveEffectiveClaudePermissionMode,
  resolveEffectiveCodexOptions,
  getSessionPermissionSummary,
  getSessionPermissionDetails,
  setStatusCardBinding,
  setCurrentInteractionMessage,
} from '../src/session-registry.ts';

function validDir(): string {
  return '/tmp';
}

function baseParams(overrides: Record<string, any> = {}) {
  return {
    channelId: 'ch-1',
    categoryId: 'cat-1',
    projectName: 'test-project',
    agentLabel: 'test-session',
    provider: 'claude' as const,
    directory: validDir(),
    type: 'persistent' as const,
    ...overrides,
  };
}

describe('session-registry: createSession', () => {
  it('creates a session with default values', async () => {
    const session = await createSession(baseParams());
    expect(session.id).toBe('test-session');
    expect(session.channelId).toBe('ch-1');
    expect(session.categoryId).toBe('cat-1');
    expect(session.provider).toBe('claude');
    expect(session.mode).toBe('auto');
    expect(session.verbose).toBe(false);
    expect(session.subagentDepth).toBe(0);
    expect(session.workflowState.status).toBe('idle');
    expect(session.messageCount).toBe(0);
    expect(session.totalCost).toBe(0);
    expect(session.isGenerating).toBe(false);
  });

  it('auto-deduplicates internal IDs', async () => {
    const s1 = await createSession(baseParams({ channelId: 'ch-10', agentLabel: 'fix-bug' }));
    const s2 = await createSession(baseParams({ channelId: 'ch-11', agentLabel: 'fix-bug' }));
    expect(s1.id).toBe('fix-bug');
    expect(s2.id).toBe('fix-bug-2');
  });

  it('throws if directory does not exist', async () => {
    await expect(createSession(baseParams({ directory: '/nonexistent-dir-xyz' })))
      .rejects.toThrow('Directory does not exist');
  });

  it('throws if channelId already exists', async () => {
    await createSession(baseParams({ channelId: 'ch-dup' }));
    await expect(createSession(baseParams({ channelId: 'ch-dup', agentLabel: 'other' })))
      .rejects.toThrow('already exists');
  });
});

describe('session-registry: getSession / lookups', () => {
  it('getSession retrieves by internal id', async () => {
    await createSession(baseParams({ channelId: 'ch-l1', agentLabel: 'lookup-test' }));
    const session = getSession('lookup-test');
    expect(session).toBeDefined();
    expect(session!.channelId).toBe('ch-l1');
  });

  it('getSessionByChannel retrieves by channelId', async () => {
    await createSession(baseParams({ channelId: 'ch-l2', agentLabel: 'lookup-ch' }));
    const session = getSessionByChannel('ch-l2');
    expect(session).toBeDefined();
    expect(session!.id).toBe('lookup-ch');
  });

  it('getSessionByChannel returns undefined for missing channel', () => {
    expect(getSessionByChannel('nonexistent')).toBeUndefined();
  });

  it('getSession returns undefined for missing id', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });
});

describe('session-registry: getSessionsByCategory', () => {
  it('returns sessions for a category', async () => {
    await createSession(baseParams({ channelId: 'ch-c1', categoryId: 'cat-abc', agentLabel: 'a' }));
    await createSession(baseParams({ channelId: 'ch-c2', categoryId: 'cat-abc', agentLabel: 'b' }));
    const sessions = getSessionsByCategory('cat-abc');
    expect(sessions).toHaveLength(2);
  });

  it('returns empty array for unknown category', () => {
    expect(getSessionsByCategory('unknown-cat')).toEqual([]);
  });
});

describe('session-registry: getAllSessions', () => {
  it('returns all sessions', async () => {
    await createSession(baseParams({ channelId: 'ch-all1', agentLabel: 'all-1' }));
    await createSession(baseParams({ channelId: 'ch-all2', agentLabel: 'all-2' }));
    const all = getAllSessions();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe('session-registry: updateSession', () => {
  it('patches session fields', async () => {
    await createSession(baseParams({ channelId: 'ch-u1', agentLabel: 'update-me' }));
    updateSession('update-me', { messageCount: 42, verbose: true });
    const session = getSession('update-me');
    expect(session!.messageCount).toBe(42);
    expect(session!.verbose).toBe(true);
  });

  it('does nothing for unknown session', () => {
    expect(() => updateSession('unknown', { verbose: true })).not.toThrow();
  });
});

describe('session-registry: endSession', () => {
  it('removes session from all indexes', async () => {
    await createSession(baseParams({ channelId: 'ch-end', agentLabel: 'to-end' }));
    expect(getSession('to-end')).toBeDefined();
    expect(getSessionByChannel('ch-end')).toBeDefined();

    await endSession('to-end');

    expect(getSession('to-end')).toBeUndefined();
    expect(getSessionByChannel('ch-end')).toBeUndefined();
    expect(getSessionsByCategory('cat-1')).not.toContainEqual(expect.objectContaining({ id: 'to-end' }));
  });

  it('throws for unknown session', async () => {
    await expect(endSession('nonexistent')).rejects.toThrow('not found');
  });
});

describe('session-registry: permission management', () => {
  it('resolveEffectiveClaudePermissionMode returns bypass for auto mode', async () => {
    await createSession(baseParams({ channelId: 'ch-p1', agentLabel: 'perm-auto' }));
    const session = getSessionByChannel('ch-p1')!;
    expect(resolveEffectiveClaudePermissionMode(session)).toBe('bypass');
  });

  it('resolveEffectiveClaudePermissionMode respects claudePermissionMode', async () => {
    await createSession(baseParams({
      channelId: 'ch-p2', agentLabel: 'perm-normal', mode: 'normal', claudePermissionMode: 'normal',
    }));
    const session = getSessionByChannel('ch-p2')!;
    expect(resolveEffectiveClaudePermissionMode(session)).toBe('normal');
  });

  it('resolveEffectiveCodexOptions returns bypass defaults when codexBypass=true', async () => {
    await createSession(baseParams({
      channelId: 'ch-p3', agentLabel: 'perm-bypass', provider: 'codex', codexBypass: true,
    }));
    const session = getSessionByChannel('ch-p3')!;
    const opts = resolveEffectiveCodexOptions(session);
    expect(opts.bypass).toBe(true);
    expect(opts.sandboxMode).toBe('danger-full-access');
  });

  it('getSessionPermissionSummary returns codex details when not bypass', async () => {
    await createSession(baseParams({
      channelId: 'ch-p4', agentLabel: 'perm-summary', provider: 'codex',
    }));
    const session = getSessionByChannel('ch-p4')!;
    const summary = getSessionPermissionSummary(session);
    expect(summary).toContain('workspace-write');
  });

  it('getSessionPermissionDetails returns claude format', async () => {
    await createSession(baseParams({ channelId: 'ch-p5', agentLabel: 'perm-detail' }));
    const session = getSessionByChannel('ch-p5')!;
    const details = getSessionPermissionDetails(session);
    expect(details).toContain('Claude:');
  });
});

describe('session-registry: session state', () => {
  it('setMode changes mode and resets workflowState', async () => {
    await createSession(baseParams({ channelId: 'ch-s1', agentLabel: 'state-mode' }));
    setMode('state-mode', 'plan');
    const session = getSession('state-mode');
    expect(session!.mode).toBe('plan');
    expect(session!.workflowState.iteration).toBe(0);
  });

  it('setMode to monitor clears monitorProviderSessionId', async () => {
    await createSession(baseParams({ channelId: 'ch-s2', agentLabel: 'state-monitor' }));
    // Manually set a monitor provider session id
    const session = getSession('state-monitor')!;
    session.monitorProviderSessionId = 'some-provider-id';
    setMode('state-monitor', 'monitor');
    expect(getSession('state-monitor')!.monitorProviderSessionId).toBeUndefined();
  });

  it('setVerbose changes verbose flag', async () => {
    await createSession(baseParams({ channelId: 'ch-s3', agentLabel: 'state-verbose' }));
    setVerbose('state-verbose', true);
    expect(getSession('state-verbose')!.verbose).toBe(true);
  });

  it('setModel changes model', async () => {
    await createSession(baseParams({ channelId: 'ch-s4', agentLabel: 'state-model' }));
    setModel('state-model', 'claude-sonnet-4-20250514');
    expect(getSession('state-model')!.model).toBe('claude-sonnet-4-20250514');
  });

  it('setAgentPersona changes persona', async () => {
    await createSession(baseParams({ channelId: 'ch-s5', agentLabel: 'state-persona' }));
    setAgentPersona('state-persona', 'senior-dev');
    expect(getSession('state-persona')!.agentPersona).toBe('senior-dev');
    setAgentPersona('state-persona', undefined);
    expect(getSession('state-persona')!.agentPersona).toBeUndefined();
  });
});

describe('session-registry: monitor goal', () => {
  it('setMonitorGoal sets goal and resets workflowState', async () => {
    await createSession(baseParams({ channelId: 'ch-mg1', agentLabel: 'monitor-goal' }));
    setMonitorGoal('monitor-goal', 'Verify login works');
    const session = getSession('monitor-goal');
    expect(session!.monitorGoal).toBe('Verify login works');
    expect(session!.workflowState.iteration).toBe(0);
  });

  it('setMonitorGoal to undefined clears monitorProviderSessionId', async () => {
    await createSession(baseParams({ channelId: 'ch-mg2', agentLabel: 'monitor-clear' }));
    const s = getSession('monitor-clear')!;
    s.monitorProviderSessionId = 'pid';
    setMonitorGoal('monitor-clear', undefined);
    expect(getSession('monitor-clear')!.monitorProviderSessionId).toBeUndefined();
  });
});

describe('session-registry: workflow state', () => {
  it('updateWorkflowState with patch merges fields', async () => {
    await createSession(baseParams({ channelId: 'ch-w1', agentLabel: 'wf-patch' }));
    updateWorkflowState('wf-patch', { status: 'worker_running', iteration: 3 });
    const session = getSession('wf-patch')!;
    expect(session.workflowState.status).toBe('worker_running');
    expect(session.workflowState.iteration).toBe(3);
    expect(session.workflowState.updatedAt).toBeGreaterThan(0);
  });

  it('updateWorkflowState with function transforms state', async () => {
    await createSession(baseParams({ channelId: 'ch-w2', agentLabel: 'wf-fn' }));
    updateWorkflowState('wf-fn', (s) => ({ ...s, iteration: s.iteration + 1 }));
    expect(getSession('wf-fn')!.workflowState.iteration).toBe(1);
  });

  it('resetWorkflowState resets to defaults', async () => {
    await createSession(baseParams({ channelId: 'ch-w3', agentLabel: 'wf-reset' }));
    updateWorkflowState('wf-reset', { status: 'completed' });
    resetWorkflowState('wf-reset');
    const session = getSession('wf-reset')!;
    expect(session.workflowState.status).toBe('idle');
    expect(session.workflowState.iteration).toBe(0);
  });
});

describe('session-registry: codex session tracking', () => {
  it('getSessionByCodexId finds codex session by providerSessionId', async () => {
    await createSession(baseParams({
      channelId: 'ch-codex1',
      agentLabel: 'codex-s1',
      provider: 'codex',
      providerSessionId: 'codex-abc-123',
    }));
    const session = getSessionByCodexId('codex-abc-123');
    expect(session).toBeDefined();
    expect(session!.id).toBe('codex-s1');
  });

  it('getSessionByCodexId returns undefined for non-codex session', async () => {
    await createSession(baseParams({ channelId: 'ch-codex2', agentLabel: 'not-codex' }));
    expect(getSessionByCodexId('anything')).toBeUndefined();
  });

  it('getSessionByProviderSession finds by provider and id', async () => {
    await createSession(baseParams({
      channelId: 'ch-codex3',
      agentLabel: 'provider-s',
      provider: 'codex',
      providerSessionId: 'prov-456',
    }));
    const session = getSessionByProviderSession('codex', 'prov-456');
    expect(session).toBeDefined();
    expect(session!.providerSessionId).toBe('prov-456');
  });

  it('getSessionByProviderSession returns undefined for empty id', () => {
    expect(getSessionByProviderSession('codex', '')).toBeUndefined();
  });
});

describe('session-registry: findCodexSessionForMonitor', () => {
  it('finds codex session by providerSessionId first', async () => {
    await createSession(baseParams({
      channelId: 'ch-mon1',
      agentLabel: 'codex-for-monitor',
      provider: 'codex',
      providerSessionId: 'monitor-prov-id',
      directory: validDir(),
    }));
    const session = findCodexSessionForMonitor('monitor-prov-id', validDir());
    expect(session).toBeDefined();
    expect(session!.id).toBe('codex-for-monitor');
  });

  it('finds codex session by cwd match when no providerSessionId', async () => {
    await createSession(baseParams({
      channelId: 'ch-mon2',
      agentLabel: 'codex-cwd',
      provider: 'codex',
      directory: validDir(),
    }));
    const session = findCodexSessionForMonitor(undefined, validDir());
    expect(session).toBeDefined();
    expect(session!.provider).toBe('codex');
  });

  it('finds codex session by cwd subdirectory', async () => {
    await createSession(baseParams({
      channelId: 'ch-mon3',
      agentLabel: 'codex-subdir',
      provider: 'codex',
      directory: '/tmp',
    }));
    const session = findCodexSessionForMonitor(undefined, '/tmp/subdir');
    expect(session).toBeDefined();
  });

  it('returns undefined when no match', () => {
    expect(findCodexSessionForMonitor(undefined, undefined)).toBeUndefined();
    expect(findCodexSessionForMonitor(undefined, '/totally-unknown')).toBeUndefined();
  });
});

describe('session-registry: abort management', () => {
  it('abortSessionWithReason sets reason and returns true when isGenerating', async () => {
    await createSession(baseParams({ channelId: 'ch-ab1', agentLabel: 'abort-gen' }));
    const controller = new AbortController();
    setSessionController('abort-gen', controller);
    markSessionGenerating('abort-gen', true);

    const result = abortSessionWithReason('abort-gen', 'user');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('abortSessionWithReason returns true when controller exists but not generating', async () => {
    await createSession(baseParams({ channelId: 'ch-ab2', agentLabel: 'abort-ctrl' }));
    const controller = new AbortController();
    setSessionController('abort-ctrl', controller);

    const result = abortSessionWithReason('abort-ctrl', 'watchdog');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('abortSessionWithReason returns false for unknown session', () => {
    expect(abortSessionWithReason('nonexistent', 'user')).toBe(false);
  });

  it('consumeAbortReason returns and clears reason', async () => {
    await createSession(baseParams({ channelId: 'ch-ab3', agentLabel: 'consume-reason' }));
    abortSessionWithReason('consume-reason', 'watchdog');
    const reason = consumeAbortReason('consume-reason');
    expect(reason).toBe('watchdog');
    // Second call should return undefined
    expect(consumeAbortReason('consume-reason')).toBeUndefined();
  });

  it('consumeAbortReason returns undefined for unknown session', () => {
    expect(consumeAbortReason('nonexistent')).toBeUndefined();
  });

  it('getSessionController returns controller', async () => {
    await createSession(baseParams({ channelId: 'ch-ab4', agentLabel: 'get-ctrl' }));
    const controller = new AbortController();
    setSessionController('get-ctrl', controller);
    expect(getSessionController('get-ctrl')).toBe(controller);
  });

  it('getSessionController returns undefined for unknown session', () => {
    expect(getSessionController('nonexistent')).toBeUndefined();
  });

  it('clearSessionController removes controller', async () => {
    await createSession(baseParams({ channelId: 'ch-ab5', agentLabel: 'clear-ctrl' }));
    setSessionController('clear-ctrl', new AbortController());
    clearSessionController('clear-ctrl');
    expect(getSessionController('clear-ctrl')).toBeUndefined();
  });
});

describe('session-registry: bindings', () => {
  it('setStatusCardBinding sets statusCardMessageId', async () => {
    await createSession(baseParams({ channelId: 'ch-bind1', agentLabel: 'binding-s' }));
    setStatusCardBinding('binding-s', { messageId: 'msg-123' });
    expect(getSession('binding-s')!.statusCardMessageId).toBe('msg-123');
  });

  it('setCurrentInteractionMessage sets currentInteractionMessageId', async () => {
    await createSession(baseParams({ channelId: 'ch-bind2', agentLabel: 'binding-i' }));
    setCurrentInteractionMessage('binding-i', 'interact-456');
    expect(getSession('binding-i')!.currentInteractionMessageId).toBe('interact-456');
    setCurrentInteractionMessage('binding-i', undefined);
    expect(getSession('binding-i')!.currentInteractionMessageId).toBeUndefined();
  });
});

describe('session-registry: updateSessionPermissions', () => {
  it('updates permission fields and lastActivity', async () => {
    await createSession(baseParams({ channelId: 'ch-perm1', agentLabel: 'perm-update' }));
    const before = getSession('perm-update')!.lastActivity;
    await updateSessionPermissions('perm-update', { claudePermissionMode: 'bypass' });
    const session = getSession('perm-update')!;
    expect(session.claudePermissionMode).toBe('bypass');
    expect(session.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it('throws for unknown session', async () => {
    await expect(updateSessionPermissions('unknown', { claudePermissionMode: 'bypass' }))
      .rejects.toThrow('not found');
  });
});
