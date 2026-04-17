import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockGetSession = vi.fn();
vi.mock('../src/session-registry.ts', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockHandleAwaitingHuman = vi.fn().mockResolvedValue(undefined);
const mockUpdateState = vi.fn().mockResolvedValue(undefined);
const mockQueueDigest = vi.fn();
vi.mock('../src/output-port.ts', () => ({
  getOutputPort: () => ({
    handleAwaitingHuman: mockHandleAwaitingHuman,
    updateState: mockUpdateState,
    queueDigest: mockQueueDigest,
  }),
}));

const mockRegisterReceiptHandle = vi.fn();
const mockGetSnapshot = vi.fn(() => ({ batchApprovalMode: false }));
const mockEnqueuePendingApproval = vi.fn();
vi.mock('@workspacecord/state', () => ({
  gateCoordinator: {
    registerReceiptHandle: (...args: unknown[]) => mockRegisterReceiptHandle(...args),
  },
  stateMachine: {
    getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    enqueuePendingApproval: (...args: unknown[]) => mockEnqueuePendingApproval(...args),
  },
}));

const mockEnqueueBatchApproval = vi.fn();
vi.mock('../src/output/batch-approval-store.ts', () => ({
  enqueueBatchApproval: (...args: unknown[]) => mockEnqueueBatchApproval(...args),
}));

vi.mock('@workspacecord/core', () => ({
  truncate: (s: string, max: number) => (s.length <= max ? s : s.slice(0, max - 1) + '…'),
  config: {
    claudePermissionMode: 'normal',
  },
}));

import {
  waitForGateResolution,
  createClaudePermissionHandler,
  shouldUseClaudePermissionHandler,
} from '../src/executor/permission-gate.ts';
import type { ThreadSession as Session } from '@workspacecord/core';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    provider: 'claude',
    mode: 'normal',
    channelId: 'chan-1',
    categoryId: 'cat-1',
    projectPath: '/tmp/project',
    projectName: 'test',
    createdAt: Date.now(),
    status: 'running',
    claudePermissionMode: undefined,
    activeHumanGateId: 'gate-1',
    ...overrides,
  } as Session;
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    toolUseID: 'tool-use-1',
    displayName: 'bash',
    title: '',
    description: '',
    decisionReason: '',
    blockedPath: '',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('permission-gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── shouldUseClaudePermissionHandler ─────────────────────────────────────

  describe('shouldUseClaudePermissionHandler', () => {
    it('returns false for non-claude provider', () => {
      expect(shouldUseClaudePermissionHandler(makeSession({ provider: 'codex' as any }))).toBe(
        false,
      );
    });

    it('returns false for auto mode', () => {
      expect(shouldUseClaudePermissionHandler(makeSession({ mode: 'auto' as any }))).toBe(false);
    });

    it('returns true for normal mode with default config', () => {
      expect(shouldUseClaudePermissionHandler(makeSession())).toBe(true);
    });

    it('returns false when session claudePermissionMode is bypass', () => {
      expect(
        shouldUseClaudePermissionHandler(makeSession({ claudePermissionMode: 'bypass' as any })),
      ).toBe(false);
    });

    it('returns true when session claudePermissionMode is normal', () => {
      expect(
        shouldUseClaudePermissionHandler(makeSession({ claudePermissionMode: 'normal' as any })),
      ).toBe(true);
    });
  });

  // ── waitForGateResolution ────────────────────────────────────────────────

  describe('waitForGateResolution', () => {
    it('registers a receipt handle and resolves on approve', async () => {
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          // Simulate immediate approval from discord
          handle.resolve('approve', 'discord');
        },
      );

      const session = makeSession();
      const result = await waitForGateResolution(session, 'gate-1');

      expect(result).toEqual({ action: 'approve', source: 'discord' });
      expect(mockRegisterReceiptHandle).toHaveBeenCalledWith('gate-1', expect.objectContaining({
        type: 'claude',
        sessionId: 'sess-1',
      }));
    });

    it('resolves with reject on rejection from terminal', async () => {
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('reject', 'terminal');
        },
      );

      const result = await waitForGateResolution(makeSession(), 'gate-1');
      expect(result).toEqual({ action: 'reject', source: 'terminal' });
    });

    it('resolves with reject/timeout on handle.reject()', async () => {
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { reject: (...args: any[]) => void }) => {
          handle.reject('timeout');
        },
      );

      const result = await waitForGateResolution(makeSession(), 'gate-1');
      expect(result).toEqual({ action: 'reject', source: 'timeout' });
    });

    it('uses codex type for codex provider', async () => {
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('approve', 'discord');
        },
      );

      await waitForGateResolution(makeSession({ provider: 'codex' as any }), 'gate-1');
      expect(mockRegisterReceiptHandle).toHaveBeenCalledWith('gate-1', expect.objectContaining({
        type: 'codex',
      }));
    });

    it('only settles once even if resolve is called multiple times', async () => {
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('approve', 'discord');
          handle.resolve('reject', 'terminal'); // second call should be ignored
        },
      );

      const result = await waitForGateResolution(makeSession(), 'gate-1');
      expect(result).toEqual({ action: 'approve', source: 'discord' });
    });
  });

  // ── createClaudePermissionHandler ────────────────────────────────────────

  describe('createClaudePermissionHandler', () => {
    it('returns allow when gate is approved', async () => {
      const session = makeSession({ activeHumanGateId: 'gate-1' });
      mockGetSession.mockReturnValue(session);
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('approve', 'discord');
        },
      );

      const handler = createClaudePermissionHandler(session, null);
      const result = await handler('bash', { command: 'ls' }, makeContext());

      expect(result).toEqual({ behavior: 'allow', toolUseID: 'tool-use-1' });
      expect(mockHandleAwaitingHuman).toHaveBeenCalledWith('sess-1', expect.any(String), {
        source: 'claude',
      });
      expect(mockUpdateState).toHaveBeenCalledWith(
        'sess-1',
        expect.objectContaining({
          type: 'human_resolved',
          metadata: expect.objectContaining({ action: 'approve', source: 'discord' }),
        }),
      );
    });

    it('returns deny with interrupt when gate is rejected from discord', async () => {
      const session = makeSession({ activeHumanGateId: 'gate-1' });
      mockGetSession.mockReturnValue(session);
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('reject', 'discord');
        },
      );

      const handler = createClaudePermissionHandler(session, null);
      const result = await handler('bash', { command: 'rm -rf /' }, makeContext());

      expect(result).toEqual({
        behavior: 'deny',
        message: '已在 Discord 拒绝',
        interrupt: true,
        toolUseID: 'tool-use-1',
      });
    });

    it('returns deny with timeout message on timeout', async () => {
      const session = makeSession({ activeHumanGateId: 'gate-1' });
      mockGetSession.mockReturnValue(session);
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { reject: (...args: any[]) => void }) => {
          handle.reject('timeout');
        },
      );

      const handler = createClaudePermissionHandler(session, null);
      const result = await handler('bash', {}, makeContext());

      expect(result).toEqual({
        behavior: 'deny',
        message: '审批超时（5 分钟）',
        interrupt: true,
        toolUseID: 'tool-use-1',
      });
    });

    it('returns deny with terminal message on terminal rejection', async () => {
      const session = makeSession({ activeHumanGateId: 'gate-1' });
      mockGetSession.mockReturnValue(session);
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('reject', 'terminal');
        },
      );

      const handler = createClaudePermissionHandler(session, null);
      const result = await handler('bash', {}, makeContext());

      expect(result).toEqual({
        behavior: 'deny',
        message: '已在终端拒绝',
        interrupt: true,
        toolUseID: 'tool-use-1',
      });
    });

    it('returns deny when no gateId is available after handleAwaitingHuman', async () => {
      const session = makeSession({ activeHumanGateId: undefined });
      mockGetSession.mockReturnValue(session);

      const handler = createClaudePermissionHandler(session, null);
      const result = await handler('bash', {}, makeContext());

      expect(result).toEqual({
        behavior: 'deny',
        message: '未能创建人工门控',
        interrupt: true,
        toolUseID: 'tool-use-1',
      });
      // Should NOT have called registerReceiptHandle since no gateId
      expect(mockRegisterReceiptHandle).not.toHaveBeenCalled();
    });

    it('includes context details in permission detail string', async () => {
      const session = makeSession({ activeHumanGateId: 'gate-1' });
      mockGetSession.mockReturnValue(session);
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('approve', 'discord');
        },
      );

      const handler = createClaudePermissionHandler(session, null);
      await handler(
        'file_write',
        { path: '/etc/hosts' },
        makeContext({
          title: 'Write to system file',
          description: 'Writing to a protected file',
          decisionReason: 'Outside allowed paths',
          blockedPath: '/etc/hosts',
        }),
      );

      const detailArg = mockHandleAwaitingHuman.mock.calls[0][1] as string;
      expect(detailArg).toContain('Write to system file');
      expect(detailArg).toContain('Writing to a protected file');
      expect(detailArg).toContain('Outside allowed paths');
      expect(detailArg).toContain('/etc/hosts');
    });

    it('omits empty input from detail string', async () => {
      const session = makeSession({ activeHumanGateId: 'gate-1' });
      mockGetSession.mockReturnValue(session);
      mockRegisterReceiptHandle.mockImplementation(
        (_gateId: string, handle: { resolve: (...args: any[]) => void }) => {
          handle.resolve('approve', 'discord');
        },
      );

      const handler = createClaudePermissionHandler(session, null);
      await handler('bash', {}, makeContext({ title: 'Test' }));

      const detailArg = mockHandleAwaitingHuman.mock.calls[0][1] as string;
      expect(detailArg).not.toContain('输入：');
    });
  });
});
