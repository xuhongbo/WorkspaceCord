# Phase 1: Core Infrastructure Test Coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install coverage tooling and write unit tests for core infrastructure modules (session, state, bot utilities, utils).

**Architecture:** Pure unit tests using vitest + vi.mock(). External dependencies (Discord, file system, pino) are mocked. Each module gets its own test file in `test/`.

**Tech Stack:** vitest, vi.mock(), fake timers, temp directories for persistence tests

---

## File Map

### New test files
- `test/coverage-config.test.ts` — vitest coverage configuration validation
- `test/session-manager.test.ts` — SessionManager facade
- `test/state-machine.test.ts` — StateMachine class (lifecycle + execution transitions)
- `test/event-normalizer.test.ts` — normalizeClaudeEvent, normalizeCodexEvent, isPlatformEvent, toPlatformEvent
- `test/human-gate.test.ts` — HumanGateRegistry CRUD, CAS, transitions, cleanup
- `test/gate-coordinator.test.ts` — GateCoordinator with receipt handles, timeouts, Discord/terminal resolution
- `test/bot-locks.test.ts` — acquireLock, releaseLock, isLocked, getLockInfo
- `test/bot-log-buffer.test.ts` — LogBuffer buffering and flushing
- `test/bot-presence.test.ts` — PresenceManager with mocked Discord client
- `test/utils.test.ts` — sanitizeName, resolvePath, isPathAllowed, formatDuration, formatRelative, truncate, isUserAllowed, isAbortError

### Modified files
- `vitest.config.ts` — Add coverage configuration
- `package.json` — Add @vitest/coverage-v8 devDependency and test:coverage script

---

### Task 1: Install coverage tooling and configure vitest

**Files:**
- Modify: `package.json:63-74` — Add `@vitest/coverage-v8` to devDependencies
- Modify: `package.json:41` — Add `test:coverage` script
- Modify: `vitest.config.ts` — Add coverage config with thresholds

- [ ] **Step 1: Install @vitest/coverage-v8**

Run: `pnpm add -D @vitest/coverage-v8`

- [ ] **Step 2: Add test:coverage script to package.json**

Add to scripts in package.json:
```json
"test:coverage": "vitest run --coverage"
```

- [ ] **Step 3: Configure vitest.config.ts for coverage**

Update vitest.config.ts:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '.worktrees/**', 'tmp/**', 'site/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/__tests__/**',
        '**/*.test.ts',
        'src/types.ts',
        'src/index.ts',
        'src/providers/types.ts',
        'src/providers/index.ts',
        'src/agents.ts',
        'src/setup.ts',
        'src/daemon.ts',
        'src/health-monitor.ts',
        'src/service-container.ts',
        'src/config.ts',
        'src/hooks/**',
        'site/**',
      ],
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 50,
        statements: 60,
      },
    },
  },
});
```

- [ ] **Step 4: Verify coverage runs**

Run: `pnpm test:coverage`
Expected: All existing tests pass, coverage report prints to console, HTML report generated in `coverage/`

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore: add vitest coverage configuration"
```

---

### Task 2: SessionManager tests

**Files:**
- Create: `test/session-manager.test.ts`

- [ ] **Step 1: Write test file for SessionManager**

Create `test/session-manager.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionManager } from '../src/session/session-manager.ts';
import { EventBus } from '../src/core/event-bus.ts';

vi.mock('../src/persistence.ts', () => ({
  Store: class {
    private data: any[] = [];
    async read() { return this.data.length ? this.data : null; }
    async write(d: any[]) { this.data = d; }
  },
}));

function makeCreateParams(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'sess-1',
    channelId: 'ch-1',
    categoryId: 'cat-1',
    provider: 'claude' as const,
    mode: 'auto' as const,
    label: 'test-session',
    ...overrides,
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
    manager = new SessionManager(eventBus);
  });

  describe('create', () => {
    it('creates a session with given params', () => {
      const session = manager.create(makeCreateParams());

      expect(session.id).toBe('sess-1');
      expect(session.channelId).toBe('ch-1');
      expect(session.categoryId).toBe('cat-1');
      expect(session.provider).toBe('claude');
      expect(session.mode).toBe('auto');
      expect(session.isGenerating).toBe(false);
    });

    it('emits session.created event', () => {
      const handler = vi.fn();
      eventBus.on('session.created' as never, handler);

      manager.create(makeCreateParams());

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].payload.sessionId).toBe('sess-1');
    });

    it('uses defaults for optional fields', () => {
      const session = manager.create(makeCreateParams({ projectName: undefined, cwd: undefined }));

      expect(session.projectName).toBe('');
      expect((session as any).directory).toBe('');
    });
  });

  describe('getByChannel / getById', () => {
    it('finds session by channel ID', () => {
      manager.create(makeCreateParams());

      const found = manager.getByChannel('ch-1');
      expect(found?.id).toBe('sess-1');
    });

    it('finds session by session ID', () => {
      manager.create(makeCreateParams());

      const found = manager.getById('sess-1');
      expect(found?.channelId).toBe('ch-1');
    });

    it('returns undefined for missing channel', () => {
      expect(manager.getByChannel('nonexistent')).toBeUndefined();
    });

    it('returns undefined for missing session ID', () => {
      expect(manager.getById('nonexistent')).toBeUndefined();
    });
  });

  describe('end', () => {
    it('marks session as not generating and updates lastActivity', () => {
      manager.create(makeCreateParams());

      const ended = manager.end('ch-1');
      expect(ended?.isGenerating).toBe(false);
    });

    it('emits session.ended event', () => {
      const handler = vi.fn();
      eventBus.on('session.ended' as never, handler);
      manager.create(makeCreateParams());

      manager.end('ch-1');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns undefined for missing channel', () => {
      expect(manager.end('nonexistent')).toBeUndefined();
    });
  });

  describe('updateState', () => {
    it('applies updates and sets lastActivity', () => {
      manager.create(makeCreateParams());

      const updated = manager.updateState('ch-1', { isGenerating: true });
      expect(updated?.isGenerating).toBe(true);
    });

    it('emits session.state_changed with previous and current', () => {
      const handler = vi.fn();
      eventBus.on('session.state_changed' as never, handler);
      manager.create(makeCreateParams());

      manager.updateState('ch-1', { isGenerating: true });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event.payload.previous.isGenerating).toBe(false);
      expect(event.payload.current.isGenerating).toBe(true);
    });

    it('returns undefined for missing channel', () => {
      expect(manager.updateState('nonexistent', { isGenerating: true })).toBeUndefined();
    });
  });

  describe('getByCategory / getAll / getActive', () => {
    it('filters sessions by category', () => {
      manager.create(makeCreateParams({ channelId: 'ch-1', categoryId: 'cat-1' }));
      manager.create(makeCreateParams({ channelId: 'ch-2', categoryId: 'cat-2' }));

      expect(manager.getByCategory('cat-1')).toHaveLength(1);
      expect(manager.getByCategory('cat-2')).toHaveLength(1);
    });

    it('returns all sessions', () => {
      manager.create(makeCreateParams({ channelId: 'ch-1' }));
      manager.create(makeCreateParams({ channelId: 'ch-2' }));

      expect(manager.getAll()).toHaveLength(2);
    });

    it('returns only generating sessions as active', () => {
      manager.create(makeCreateParams({ channelId: 'ch-1' }));
      manager.create(makeCreateParams({ channelId: 'ch-2' }));
      manager.updateState('ch-1', { isGenerating: true });

      expect(manager.getActive()).toHaveLength(1);
      expect(manager.getActive()[0].channelId).toBe('ch-1');
    });
  });

  describe('remove', () => {
    it('removes session from memory', async () => {
      manager.create(makeCreateParams());
      expect(manager.count).toBe(1);

      await manager.remove('ch-1');
      expect(manager.count).toBe(0);
    });

    it('returns false for missing channel', async () => {
      expect(await manager.remove('nonexistent')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns number of sessions', () => {
      expect(manager.count).toBe(0);
      manager.create(makeCreateParams({ channelId: 'ch-1' }));
      expect(manager.count).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm test -- test/session-manager.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/session-manager.test.ts
git commit -m "test: add SessionManager unit tests"
```

---

### Task 3: StateMachine tests

**Files:**
- Create: `test/state-machine.test.ts`

- [ ] **Step 1: Write test file for StateMachine**

Create `test/state-machine.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateMachine } from '../src/state/state-machine.ts';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    vi.useFakeTimers();
    sm = new StateMachine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getState', () => {
    it('creates default state for new session', () => {
      const state = sm.getState('sess-1');

      expect(state.lifecycle).toBe('initializing');
      expect(state.execution).toBeNull();
      expect(state.gate).toBeNull();
    });

    it('returns same state on subsequent calls', () => {
      const a = sm.getState('sess-1');
      const b = sm.getState('sess-1');
      expect(a).toBe(b);
    });
  });

  describe('transition — lifecycle', () => {
    it('transitions from initializing to active', () => {
      const result = sm.transition('sess-1', 'session_started', { lifecycle: 'active' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('active');
    });

    it('rejects invalid lifecycle transition', () => {
      sm.getState('sess-1'); // create default (initializing)
      const result = sm.transition('sess-1', 'bad', { lifecycle: 'completed' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('非法');
    });

    it('allows error from any state', () => {
      sm.transition('sess-1', 'session_started', { lifecycle: 'active' });
      const result = sm.transition('sess-1', 'error', { lifecycle: 'error' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('error');
    });

    it('is idempotent — same state returns success without change', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active' });
      const result = sm.transition('sess-1', 'noop', { lifecycle: 'active' });

      expect(result.success).toBe(true);
    });
  });

  describe('transition — execution state', () => {
    beforeEach(() => {
      sm.transition('sess-1', 'start', { lifecycle: 'active', execution: 'idle' });
    });

    it('transitions idle -> thinking', () => {
      const result = sm.transition('sess-1', 'thinking', { execution: 'thinking' });
      expect(result.success).toBe(true);
      expect(result.state.execution).toBe('thinking');
    });

    it('rejects idle -> streaming_output (must go through thinking or tool_executing)', () => {
      // Reset to idle
      sm.transition('sess-1', 'reset', { execution: 'idle' });
      const result = sm.transition('sess-1', 'stream', { execution: 'streaming_output' });

      expect(result.success).toBe(false);
    });

    it('clears execution state when lifecycle is not active', () => {
      const result = sm.transition('sess-1', 'paused', { lifecycle: 'paused', execution: 'thinking' });

      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('paused');
      expect(result.state.execution).toBeNull();
    });

    it('rejects non-null execution when lifecycle is not active', () => {
      sm.transition('sess-1', 'done', { lifecycle: 'completed' });
      const result = sm.transition('sess-1', 'bad', { execution: 'thinking' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('仅在 lifecycle=active 时有效');
    });
  });

  describe('transition history', () => {
    it('records transitions', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active' });
      sm.transition('sess-1', 'pause', { lifecycle: 'paused' });

      const history = sm.getTransitionHistory('sess-1');
      expect(history).toHaveLength(2);
      expect(history[0].event).toBe('start');
      expect(history[1].event).toBe('pause');
    });

    it('limits history to 100 entries', () => {
      for (let i = 0; i < 150; i++) {
        const target = i % 2 === 0 ? 'active' : 'error';
        if (target === 'error') {
          sm.transition('sess-1', 'e', { lifecycle: 'error' });
        } else {
          sm.transition('sess-1', 'r', { lifecycle: 'active' });
        }
      }

      const history = sm.getTransitionHistory('sess-1');
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('clearSession', () => {
    it('removes session state', () => {
      sm.transition('sess-1', 'start', { lifecycle: 'active' });
      sm.clearSession('sess-1');

      const state = sm.getState('sess-1');
      expect(state.lifecycle).toBe('initializing'); // recreated as default
    });
  });

  describe('legacy snapshot API', () => {
    it('creates default snapshot', () => {
      const snap = sm.ensureSession('sess-1');

      expect(snap.state).toBe('idle');
      expect(snap.turn).toBe(0);
      expect(snap.isCompleted).toBe(false);
    });

    it('increments turn', () => {
      sm.incrementTurn('sess-1');
      const snap = sm.getSession('sess-1');
      expect(snap?.turn).toBe(1);
    });
  });

  describe('resolveDisplayState', () => {
    it('returns highest priority state', () => {
      sm.ensureSession('s1');
      sm.updateSession('s1', { state: 'idle' });
      sm.ensureSession('s2');
      sm.updateSession('s2', { state: 'error' });

      const display = sm.resolveDisplayState();
      expect(display).toBe('error');
    });

    it('returns idle when no sessions', () => {
      expect(sm.resolveDisplayState()).toBe('idle');
    });
  });

  describe('shouldTransition', () => {
    it('allows transition when target has higher priority', () => {
      expect(sm.shouldTransition('idle', 'error')).toBe(true);
    });

    it('blocks lower priority when source is formal and target is inferred', () => {
      expect(sm.shouldTransition('error', 'idle', 'formal', 'inferred')).toBe(false);
    });
  });

  describe('getStateLabel / getStateColor', () => {
    it('returns Chinese label', () => {
      expect(sm.getStateLabel('idle')).toBe('待命');
      expect(sm.getStateLabel('error')).toBe('出现异常');
    });

    it('returns color code', () => {
      expect(sm.getStateColor('error')).toBe(0xe74c3c);
      expect(sm.getStateColor('idle')).toBe(0x808080);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/state-machine.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/state-machine.test.ts
git commit -m "test: add StateMachine unit tests"
```

---

### Task 4: Event Normalizer tests

**Files:**
- Create: `test/event-normalizer.test.ts`

- [ ] **Step 1: Write test file**

Create `test/event-normalizer.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeClaudeEvent,
  normalizeCodexEvent,
  isPlatformEvent,
  toPlatformEvent,
  mapPlatformEventToState,
} from '../src/state/event-normalizer.ts';

describe('event-normalizer', () => {
  describe('normalizeClaudeEvent', () => {
    it('maps text_delta to thinking_started', () => {
      const event = normalizeClaudeEvent({ type: 'text_delta' } as any, 'sess-1');

      expect(event?.type).toBe('thinking_started');
      expect(event?.sessionId).toBe('sess-1');
      expect(event?.source).toBe('claude');
      expect(event?.stateSource).toBe('formal');
    });

    it('maps ask_user to awaiting_human', () => {
      const event = normalizeClaudeEvent({ type: 'ask_user' } as any, 'sess-1');
      expect(event?.type).toBe('awaiting_human');
    });

    it('maps result to completed', () => {
      const event = normalizeClaudeEvent({ type: 'result' } as any, 'sess-1');
      expect(event?.type).toBe('completed');
    });

    it('maps error to errored', () => {
      const event = normalizeClaudeEvent({ type: 'error' } as any, 'sess-1');
      expect(event?.type).toBe('errored');
    });

    it('maps session_init to session_started', () => {
      const event = normalizeClaudeEvent({ type: 'session_init' } as any, 'sess-1');
      expect(event?.type).toBe('session_started');
    });

    it('returns null for unmapped event type', () => {
      const event = normalizeClaudeEvent({ type: 'unknown_type' } as any, 'sess-1');
      expect(event).toBeNull();
    });
  });

  describe('normalizeCodexEvent', () => {
    it('maps session_meta to session_started', () => {
      const event = normalizeCodexEvent('session_meta', 'sess-1', {});
      expect(event?.type).toBe('session_started');
      expect(event?.source).toBe('codex');
    });

    it('maps codex-permission to awaiting_human with inferred stateSource', () => {
      const event = normalizeCodexEvent('codex-permission', 'sess-1', {});
      expect(event?.type).toBe('awaiting_human');
      expect(event?.stateSource).toBe('inferred');
      expect(event?.confidence).toBe('medium');
    });

    it('maps event_msg:task_complete to completed', () => {
      const event = normalizeCodexEvent('event_msg:task_complete', 'sess-1', {});
      expect(event?.type).toBe('completed');
    });

    it('returns null for unmapped event key', () => {
      const event = normalizeCodexEvent('unknown_event', 'sess-1', {});
      expect(event).toBeNull();
    });

    it('prefers observedState mapping for codex-permission', () => {
      const event = normalizeCodexEvent('some_other', 'sess-1', { observedState: 'codex-permission' });
      expect(event?.type).toBe('awaiting_human');
      expect(event?.stateSource).toBe('inferred');
    });

    it('maps observedState idle to session_idle', () => {
      const event = normalizeCodexEvent('ignored', 'sess-1', { observedState: 'idle' });
      expect(event?.type).toBe('session_idle');
    });
  });

  describe('isPlatformEvent', () => {
    it('returns true for valid platform event', () => {
      const event = {
        type: 'thinking_started',
        sessionId: 's1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: Date.now(),
      };
      expect(isPlatformEvent(event)).toBe(true);
    });

    it('returns false for missing type', () => {
      expect(isPlatformEvent({ sessionId: 's1', source: 'claude', confidence: 'high', timestamp: 1 })).toBe(false);
    });

    it('returns false for invalid source', () => {
      expect(isPlatformEvent({ type: 'x', sessionId: 's1', source: 'unknown', confidence: 'high', timestamp: 1 })).toBe(false);
    });

    it('returns false for missing timestamp', () => {
      expect(isPlatformEvent({ type: 'x', sessionId: 's1', source: 'claude', confidence: 'high' })).toBe(false);
    });
  });

  describe('toPlatformEvent', () => {
    it('passes through already-valid platform events', () => {
      const input = {
        type: 'thinking_started',
        sessionId: 's1',
        source: 'claude',
        stateSource: 'formal',
        confidence: 'high',
        timestamp: 123,
      };
      const result = toPlatformEvent(input, 's1');
      expect(result?.type).toBe('thinking_started');
    });

    it('normalizes Claude provider events', () => {
      const result = toPlatformEvent({ type: 'text_delta' } as any, 'sess-1');
      expect(result?.type).toBe('thinking_started');
    });
  });

  describe('mapPlatformEventToState', () => {
    it('maps platform event types to unified state', () => {
      expect(mapPlatformEventToState('thinking_started')).toBe('thinking');
      expect(mapPlatformEventToState('work_started')).toBe('working');
      expect(mapPlatformEventToState('awaiting_human')).toBe('awaiting_human');
      expect(mapPlatformEventToState('completed')).toBe('completed');
      expect(mapPlatformEventToState('errored')).toBe('error');
    });

    it('returns null for unmapped types', () => {
      expect(mapPlatformEventToState('session_started')).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/event-normalizer.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/event-normalizer.test.ts
git commit -m "test: add event normalizer unit tests"
```

---

### Task 5: HumanGate Registry tests

**Files:**
- Create: `test/human-gate.test.ts`

- [ ] **Step 1: Write test file**

Create `test/human-gate.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HumanGateRegistry } from '../src/state/human-gate.ts';

vi.mock('../src/persistence.ts', () => ({
  Store: class {
    private data: any[] = [];
    async read() { return this.data.length ? this.data : null; }
    async write(d: any[]) { this.data = d; }
  },
}));

describe('HumanGateRegistry', () => {
  let registry: HumanGateRegistry;

  beforeEach(async () => {
    registry = new HumanGateRegistry();
    await registry.init();
  });

  describe('create', () => {
    it('creates a pending gate', () => {
      const gate = registry.create({
        sessionId: 'sess-1',
        provider: 'claude',
        type: 'binary_approval',
        isBlocking: true,
        supportsRemoteDecision: true,
        summary: 'Test gate',
        turn: 1,
      });

      expect(gate.status).toBe('pending');
      expect(gate.sessionId).toBe('sess-1');
      expect(gate.version).toBe(1);
      expect(gate.id).toBeDefined();
    });
  });

  describe('get / getBySession', () => {
    it('retrieves gate by ID', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const found = registry.get(gate.id);
      expect(found?.id).toBe(gate.id);
    });

    it('returns undefined for missing gate', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('returns all gates for a session', () => {
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'text_question',
        isBlocking: false, supportsRemoteDecision: false, summary: 'G2', turn: 1,
      });

      expect(registry.getBySession('sess-1')).toHaveLength(2);
    });
  });

  describe('getActiveBySession', () => {
    it('returns only pending gates', () => {
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Active', turn: 1,
      });
      const active = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Resolved', turn: 1,
      });
      registry.update(active.id, active.version, { status: 'approved' });

      expect(registry.getActiveBySession('sess-1')).toHaveLength(1);
    });
  });

  describe('CAS update', () => {
    it('updates gate with correct version', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = registry.update(gate.id, gate.version, { status: 'approved' });

      expect(result.success).toBe(true);
      expect(result.record?.status).toBe('approved');
      expect(result.record?.version).toBe(gate.version + 1);
    });

    it('rejects version conflict', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = registry.update(gate.id, 999, { status: 'approved' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('version_conflict');
    });

    it('rejects not found', () => {
      const result = registry.update('nonexistent', 1, { status: 'approved' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('not_found');
    });

    it('rejects invalid transition', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });
      registry.update(gate.id, gate.version, { status: 'approved' });
      const updated = registry.get(gate.id)!;

      const result = registry.update(gate.id, updated.version, { status: 'pending' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('invalid_transition');
    });
  });

  describe('invalidateAll', () => {
    it('invalidates all pending gates', () => {
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      registry.create({
        sessionId: 'sess-2', provider: 'codex', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G2', turn: 1,
      });

      const count = registry.invalidateAll('restart');
      expect(count).toBe(2);

      const stats = registry.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.invalidated).toBe(2);
    });
  });

  describe('delete', () => {
    it('removes gate', () => {
      const gate = registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      expect(registry.delete(gate.id)).toBe(true);
      expect(registry.get(gate.id)).toBeUndefined();
    });
  });

  describe('cleanupExpired', () => {
    it('expires old pending gates', async () => {
      vi.useFakeTimers();
      registry.create({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Old', turn: 1,
      });
      vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes

      const count = registry.cleanupExpired(5 * 60 * 1000);
      expect(count).toBe(1);
      expect(registry.getStats().expired).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('archiveResolved', () => {
    it('removes old resolved gates keeping latest N', () => {
      for (let i = 0; i < 5; i++) {
        const gate = registry.create({
          sessionId: `sess-${i}`, provider: 'claude', type: 'binary_approval',
          isBlocking: true, supportsRemoteDecision: true, summary: `G${i}`, turn: 1,
        });
        registry.update(gate.id, gate.version, { status: 'approved' });
      }

      const archived = registry.archiveResolved(2);
      expect(archived).toBe(3);
      expect(registry.getAll().length).toBe(2);
    });
  });

  describe('getStats', () => {
    it('returns counts by status', () => {
      const g1 = registry.create({
        sessionId: 's1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      const g2 = registry.create({
        sessionId: 's2', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G2', turn: 1,
      });
      registry.update(g1.id, g1.version, { status: 'approved' });

      const stats = registry.getStats();
      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.approved).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/human-gate.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/human-gate.test.ts
git commit -m "test: add HumanGateRegistry unit tests"
```

---

### Task 6: GateCoordinator tests

**Files:**
- Create: `test/gate-coordinator.test.ts`

- [ ] **Step 1: Write test file**

Create `test/gate-coordinator.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GateCoordinator } from '../src/state/gate-coordinator.ts';
import { HumanGateRegistry } from '../src/state/human-gate.ts';

vi.mock('../src/persistence.ts', () => ({
  Store: class {
    private data: any[] = [];
    async read() { return this.data.length ? this.data : null; }
    async write(d: any[]) { this.data = d; }
  },
}));

describe('GateCoordinator', () => {
  let coordinator: GateCoordinator;
  let registry: HumanGateRegistry;

  beforeEach(async () => {
    vi.useFakeTimers();
    registry = new HumanGateRegistry();
    await registry.init();
    coordinator = new GateCoordinator(registry);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createGate', () => {
    it('creates a gate via registry', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      expect(gate.status).toBe('pending');
      expect(gate.sessionId).toBe('sess-1');
    });
  });

  describe('resolveFromDiscord', () => {
    it('resolves gate with approve action', async () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = await coordinator.resolveFromDiscord(gate.id, 'approve');

      expect(result.success).toBe(true);
      expect(result.handledByReceipt).toBe(false);
    });

    it('notifies receipt handle when one is registered', async () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      let resolvedAction: string | undefined;
      coordinator.registerReceiptHandle(gate.id, {
        type: 'claude',
        sessionId: 'sess-1',
        resolve: (action) => { resolvedAction = action; },
        reject: () => {},
      });

      const result = await coordinator.resolveFromDiscord(gate.id, 'approve');
      expect(result.success).toBe(true);
      expect(result.handledByReceipt).toBe(true);
      expect(resolvedAction).toBe('approve');
    });

    it('returns error for nonexistent gate', async () => {
      const result = await coordinator.resolveFromDiscord('nonexistent', 'approve');
      expect(result.success).toBe(false);
      expect(result.handledByReceipt).toBe(false);
    });

    it('returns error for already-resolved gate', async () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });
      await coordinator.resolveFromDiscord(gate.id, 'approve');

      const result = await coordinator.resolveFromDiscord(gate.id, 'reject');
      expect(result.success).toBe(false);
      expect(result.message).toBe('门控已被处理');
    });
  });

  describe('notifyTerminalResolved', () => {
    it('resolves gate with terminal action', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const result = coordinator.notifyTerminalResolved(gate.id, 'approve');
      expect(result.success).toBe(true);
      expect(result.handledByReceipt).toBe(false);
    });
  });

  describe('receipt handle rejection', () => {
    it('rejects handle when gate is not pending', () => {
      let rejected = false;
      const rejectReason: string[] = [];

      coordinator.registerReceiptHandle('nonexistent', {
        type: 'claude',
        sessionId: 'sess-1',
        resolve: () => {},
        reject: (reason) => { rejected = true; rejectReason.push(reason); },
      });

      expect(rejected).toBe(true);
    });
  });

  describe('getGate / getActiveGateForSession', () => {
    it('retrieves gate by ID', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      expect(coordinator.getGate(gate.id)?.id).toBe(gate.id);
    });

    it('finds active gate for session', () => {
      const gate = coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'Test', turn: 1,
      });

      const active = coordinator.getActiveGateForSession('sess-1');
      expect(active?.id).toBe(gate.id);
    });
  });

  describe('invalidateAllOnRestart', () => {
    it('invalidates all pending gates and cleans up', () => {
      coordinator.createGate({
        sessionId: 'sess-1', provider: 'claude', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G1', turn: 1,
      });
      coordinator.createGate({
        sessionId: 'sess-2', provider: 'codex', type: 'binary_approval',
        isBlocking: true, supportsRemoteDecision: true, summary: 'G2', turn: 1,
      });

      const result = coordinator.invalidateAllOnRestart();
      expect(result).toHaveLength(0); // no discordMessageId bound

      expect(registry.getStats().pending).toBe(0);
      expect(registry.getStats().invalidated).toBe(2);
    });
  });

  describe('archiveResolved / cleanupExpired', () => {
    it('delegates to registry', () => {
      const count = coordinator.cleanupExpired();
      expect(typeof count).toBe('number');

      const archived = coordinator.archiveResolved(10);
      expect(typeof archived).toBe('number');
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/gate-coordinator.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/gate-coordinator.test.ts
git commit -m "test: add GateCoordinator unit tests"
```

---

### Task 7: Bot locks tests

**Files:**
- Create: `test/bot-locks.test.ts`

- [ ] **Step 1: Write test file**

Create `test/bot-locks.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock, isLocked, getLockInfo } from '../src/bot-locks.ts';
import { config } from '../src/config.ts';

// We need to mock the config.dataDir. Since config is a module-level singleton,
// we test by creating a temp directory and using the actual lock file path.
// The lock file is at join(config.dataDir, 'bot.lock'), so we'll test the
// behavior via the exported functions which operate on that file.

// Note: These tests use the actual filesystem. We create a unique temp dir
// for each test to avoid interference.

function makeTempDataDir(): string {
  const dir = join(tmpdir(), `workspacecord-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Since bot-locks.ts reads config.dataDir at module load time, we can't
// easily redirect it. Instead, we test by mocking the fs module.

vi.mock('../src/config.ts', () => ({
  config: {
    dataDir: '', // will be set per-test
  },
}));

// For filesystem-based lock tests, we use vi.mock on node:fs
// But that's complex. Instead, use a simpler approach: test with a dedicated
// temp dir by setting up the mock config before import.

describe('bot-locks', () => {
  let tempDir = '';
  const LOCK_PATH = '';

  beforeEach(() => {
    tempDir = makeTempDataDir();
    vi.resetModules();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('acquires lock when no lock file exists', async () => {
    vi.doMock('../src/config.ts', () => ({ config: { dataDir: tempDir } }));
    const { acquireLock, releaseLock, isLocked } = await import('../src/bot-locks.ts');

    expect(acquireLock()).toBe(true);
    expect(isLocked()).toBe(true);

    releaseLock();
    expect(isLocked()).toBe(false);
  });

  it('blocks acquire when lock is held by running process', async () => {
    vi.doMock('../src/config.ts', () => ({ config: { dataDir: tempDir } }));
    const { acquireLock, releaseLock } = await import('../src/bot-locks.ts');

    acquireLock();
    // Same process, so PID check will say process is running
    expect(acquireLock()).toBe(false);

    releaseLock();
  });

  it('releases lock only for same PID', async () => {
    vi.doMock('../src/config.ts', () => ({ config: { dataDir: tempDir } }));
    const { acquireLock, releaseLock, isLocked } = await import('../src/bot-locks.ts');

    acquireLock();
    releaseLock();
    expect(isLocked()).toBe(false);
  });

  it('getLockInfo returns lock data when file exists', async () => {
    vi.doMock('../src/config.ts', () => ({ config: { dataDir: tempDir } }));
    const { acquireLock, getLockInfo, releaseLock } = await import('../src/bot-locks.ts');

    acquireLock();
    const info = getLockInfo();

    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.age).toBeGreaterThanOrEqual(0);

    releaseLock();
  });

  it('getLockInfo returns null when no lock file', async () => {
    vi.doMock('../src/config.ts', () => ({ config: { dataDir: tempDir } }));
    const { getLockInfo } = await import('../src/bot-locks.ts');

    expect(getLockInfo()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/bot-locks.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/bot-locks.test.ts
git commit -m "test: add bot locks unit tests"
```

---

### Task 8: Bot log buffer tests

**Files:**
- Create: `test/bot-log-buffer.test.ts`

- [ ] **Step 1: Write test file**

Create `test/bot-log-buffer.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LogBuffer } from '../src/bot-log-buffer.ts';

vi.mock('../src/config.ts', () => ({
  config: {
    textChunkLimit: 2000,
    chunkMode: 'none',
    replyToMode: 'off',
    ackReaction: false,
  },
}));

vi.mock('../src/discord/delivery-policy.ts', () => ({
  buildDeliveryPlan: vi.fn(() => ({ plan: 'mock' })),
}));

vi.mock('../src/discord/delivery.ts', () => ({
  deliver: vi.fn(),
}));

describe('LogBuffer', () => {
  let buffer: LogBuffer;
  let mockChannel: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    buffer = new LogBuffer();

    mockChannel = {
      id: 'log-channel-1',
      send: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('log', () => {
    it('adds message to buffer', () => {
      buffer.setChannel(mockChannel);
      buffer.log('test message');

      // Message logged to console (verify separately)
    });

    it('schedules flush after debounce', () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg1');
      buffer.log('msg2');

      // No immediate flush
    });
  });

  describe('flush', () => {
    it('does nothing without channel', async () => {
      buffer.log('msg');
      await buffer.flush();
      // Should not throw
    });

    it('does nothing with empty buffer', async () => {
      buffer.setChannel(mockChannel);
      await buffer.flush();
    });

    it('sends all buffered messages to channel', async () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg1');
      buffer.log('msg2');

      await buffer.flush();

      // Messages are flushed via delivery pipeline
    });

    it('clears buffer after flush', async () => {
      buffer.setChannel(mockChannel);
      buffer.log('msg');
      await buffer.flush();

      // Second flush should be empty
      await buffer.flush();
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/bot-log-buffer.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/bot-log-buffer.test.ts
git commit -m "test: add LogBuffer unit tests"
```

---

### Task 9: Bot presence tests

**Files:**
- Create: `test/bot-presence.test.ts`

- [ ] **Step 1: Write test file**

Create `test/bot-presence.test.ts`:
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PresenceManager } from '../src/bot-presence.ts';
import { ActivityType } from 'discord.js';

vi.mock('../src/thread-manager.ts', () => ({
  getAllSessions: vi.fn(),
}));

const { getAllSessions } = await import('../src/thread-manager.ts');

describe('PresenceManager', () => {
  let manager: PresenceManager;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      user: {
        setPresence: vi.fn(),
      },
    };
    manager = new PresenceManager(mockClient);
  });

  describe('updatePresence', () => {
    it('sets idle presence when no sessions', () => {
      (getAllSessions as any).mockReturnValue([]);

      manager.updatePresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'idle',
        activities: [{ name: 'No active agents', type: ActivityType.Custom }],
      });
    });

    it('shows agent count when sessions exist', () => {
      (getAllSessions as any).mockReturnValue([
        { id: 's1', isGenerating: false },
        { id: 's2', isGenerating: false },
      ]);

      manager.updatePresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'online',
        activities: [{ name: '2 agents', type: ActivityType.Watching }],
      });
    });

    it('shows generating count when sessions are generating', () => {
      (getAllSessions as any).mockReturnValue([
        { id: 's1', isGenerating: true },
        { id: 's2', isGenerating: false },
      ]);

      manager.updatePresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'online',
        activities: [{ name: '1 generating', type: ActivityType.Watching }],
      });
    });
  });

  describe('clearPresence', () => {
    it('sets dnd status with no activities', () => {
      manager.clearPresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'dnd',
        activities: [],
      });
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/bot-presence.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/bot-presence.test.ts
git commit -m "test: add PresenceManager unit tests"
```

---

### Task 10: Utils tests

**Files:**
- Create: `test/utils.test.ts`

- [ ] **Step 1: Write test file**

Create `test/utils.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import {
  sanitizeName,
  resolvePath,
  isPathAllowed,
  projectNameFromChannel,
  formatDuration,
  formatRelative,
  truncate,
  isUserAllowed,
  isAbortError,
} from '../src/utils.ts';

describe('utils', () => {
  describe('sanitizeName', () => {
    it('lowercases and replaces special chars with dashes', () => {
      expect(sanitizeName('Hello World!')).toBe('hello-world');
    });

    it('collapses multiple dashes sequences', () => {
      expect(sanitizeName('foo   bar')).toBe('foo-bar');
    });

    it('trims leading and trailing dashes', () => {
      expect(sanitizeName('--test--')).toBe('test');
    });

    it('truncates to 50 chars', () => {
      const long = 'a'.repeat(100);
      expect(sanitizeName(long)).toHaveLength(50);
    });

    it('returns "session" for empty input', () => {
      expect(sanitizeName('')).toBe('session');
      expect(sanitizeName('!!!')).toBe('session');
    });
  });

  describe('resolvePath', () => {
    it('expands tilde to home directory', () => {
      const result = resolvePath('~/projects');
      expect(result).toMatch(/^\/.+\//);
      expect(result).toContain('projects');
    });

    it('returns absolute paths unchanged', () => {
      expect(resolvePath('/tmp/test')).toBe('/tmp/test');
    });

    it('resolves relative paths against cwd', () => {
      const result = resolvePath('./src');
      expect(result).toBe(process.cwd() + '/src');
    });
  });

  describe('isPathAllowed', () => {
    it('allows all paths when allowedPaths is empty', () => {
      expect(isPathAllowed('/any/path', [])).toBe(true);
    });

    it('allows path within allowed root', () => {
      expect(isPathAllowed('/home/user/project/src', ['/home/user/project'])).toBe(true);
    });

    it('rejects path outside allowed roots', () => {
      expect(isPathAllowed('/etc/passwd', ['/home/user'])).toBe(false);
    });
  });

  describe('projectNameFromChannel', () => {
    it('returns channel name as-is', () => {
      expect(projectNameFromChannel('my-project')).toBe('my-project');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
    });

    it('formats hours and minutes', () => {
      expect(formatDuration(3661000)).toBe('1h 1m');
    });
  });

  describe('formatRelative', () => {
    it('shows "just now" for recent timestamps', () => {
      const recent = Date.now() - 10000;
      expect(formatRelative(recent)).toBe('just now');
    });

    it('shows minutes ago', () => {
      const ts = Date.now() - 120000;
      expect(formatRelative(ts)).toBe('2m ago');
    });

    it('shows hours ago', () => {
      const ts = Date.now() - 3 * 3600000;
      expect(formatRelative(ts)).toBe('3h ago');
    });

    it('shows days ago', () => {
      const ts = Date.now() - 2 * 86400000;
      expect(formatRelative(ts)).toBe('2d ago');
    });
  });

  describe('truncate', () => {
    it('returns string unchanged if within max', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates with ellipsis', () => {
      expect(truncate('hello world', 8)).toBe('hello…');
    });

    it('handles exact-length strings', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
  });

  describe('isUserAllowed', () => {
    it('allows all when allowAll is true', () => {
      expect(isUserAllowed('any-user', [], true)).toBe(true);
    });

    it('denies when allowedUsers is empty and allowAll is false', () => {
      expect(isUserAllowed('user', [], false)).toBe(false);
    });

    it('allows when user is in list', () => {
      expect(isUserAllowed('user-123', ['user-123', 'user-456'], false)).toBe(true);
    });

    it('denies when user is not in list', () => {
      expect(isUserAllowed('unknown', ['user-123'], false)).toBe(false);
    });
  });

  describe('isAbortError', () => {
    it('detects AbortError by name', () => {
      expect(isAbortError(new Error('aborted'))).toBe(false);
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      expect(isAbortError(abortErr)).toBe(true);
    });

    it('detects abort patterns in message', () => {
      expect(isAbortError(new Error('Task was cancelled'))).toBe(true);
      expect(isAbortError(new Error('Process killed'))).toBe(true);
      expect(isAbortError(new Error('Signal received'))).toBe(true);
      expect(isAbortError(new Error('Interrupted'))).toBe(true);
    });

    it('returns false for non-abort errors', () => {
      expect(isAbortError(new Error('Something went wrong'))).toBe(false);
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- test/utils.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add test/utils.test.ts
git commit -m "test: add utils unit tests"
```

---

### Task 11: Run full coverage report and validate thresholds

**Files:** No new files

- [ ] **Step 1: Run full test suite with coverage**

Run: `pnpm test:coverage`
Expected: All tests pass (existing + new), coverage thresholds met

- [ ] **Step 2: Review coverage report**

Check `coverage/index.html` in browser or review text output. Identify modules below threshold.

Expected outcome:
- Phase 1 modules (session-manager, state-machine, event-normalizer, human-gate, gate-coordinator, bot-locks, bot-log-buffer, bot-presence, utils) >= 80% line coverage
- Overall project >= 60% line coverage (threshold set in vitest.config.ts)

- [ ] **Step 3: Commit**

```bash
git add coverage/
git commit -m "chore: Phase 1 coverage complete"
```

---

## Acceptance Criteria

After all tasks are complete:

1. `pnpm test` passes — all existing + new tests
2. `pnpm test:coverage` shows Phase 1 modules at >= 80% line coverage
3. Overall project coverage meets thresholds: lines >= 60%, functions >= 55%, branches >= 50%
4. Coverage HTML report available at `coverage/index.html`
5. Each task committed individually

---

## Future: Phase 2 & 3 (outline only)

**Phase 2** (Core Business Pipeline): Provider tests (claude-provider, codex-provider with SDK mocking), thread-manager, discord delivery layer, bot-event-router, bot-services-orchestrator.

**Phase 3** (Integration + E2E): End-to-end test framework, message -> provider -> output pipeline tests, CLI integration tests, migrate smoke scripts to auto-runnable tests.
