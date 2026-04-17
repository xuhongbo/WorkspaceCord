import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventBus,
  GateCreated,
  GateResolved,
  SessionAwaitingHuman,
  SessionErrored,
  SessionCreated,
  SessionEnded,
  SessionModeChanged,
  MonitorRunStarted,
  MonitorRunEnded,
  getDomainBus,
  _setDomainBusForTest,
} from '../src/index.ts';

describe('domain event catalog (P3a)', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    _setDomainBusForTest(bus);
  });

  afterEach(() => {
    _setDomainBusForTest(null);
  });

  it('getDomainBus returns the injected test bus', () => {
    expect(getDomainBus()).toBe(bus);
  });

  it('GateCreated payload is type-safe and observable', () => {
    const handler = vi.fn();
    bus.on(GateCreated, handler);
    bus.emit(
      GateCreated,
      { gateId: 'g1', sessionId: 's1', provider: 'claude', isBlocking: true },
      'test',
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0][0];
    expect(event.payload).toEqual({
      gateId: 'g1',
      sessionId: 's1',
      provider: 'claude',
      isBlocking: true,
    });
    expect(event.traceId).toBeTypeOf('string');
    expect(event.source).toBe('test');
  });

  it('GateResolved carries resolvedBy + action', () => {
    const handler = vi.fn();
    bus.on(GateResolved, handler);
    bus.emit(
      GateResolved,
      {
        gateId: 'g1',
        status: 'approved',
        resolvedBy: 'terminal',
        resolvedAction: 'approve',
      },
      'test',
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.status).toBe('approved');
  });

  it('SessionAwaitingHuman + SessionErrored are distinct event types', () => {
    const awaitHandler = vi.fn();
    const errorHandler = vi.fn();
    bus.on(SessionAwaitingHuman, awaitHandler);
    bus.on(SessionErrored, errorHandler);

    bus.emit(SessionAwaitingHuman, { sessionId: 's1', detail: 'approve?', turn: 2 });
    bus.emit(SessionErrored, { sessionId: 's1', errorMessage: 'boom', phase: 'stream' });

    expect(awaitHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(awaitHandler.mock.calls[0][0].payload.detail).toBe('approve?');
    expect(errorHandler.mock.calls[0][0].payload.errorMessage).toBe('boom');
  });

  it('multiple subscribers on the same event all fire (fan-out)', () => {
    const a = vi.fn();
    const b = vi.fn();
    bus.on(GateCreated, a);
    bus.on(GateCreated, b);
    bus.emit(GateCreated, { gateId: 'x', sessionId: 's', provider: 'claude', isBlocking: false });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('SessionCreated / SessionEnded / SessionModeChanged round-trip', () => {
    const created = vi.fn();
    const ended = vi.fn();
    const modeChanged = vi.fn();
    bus.on(SessionCreated, created);
    bus.on(SessionEnded, ended);
    bus.on(SessionModeChanged, modeChanged);

    bus.emit(SessionCreated, {
      sessionId: 's1',
      channelId: 'c1',
      categoryId: 'cat1',
      provider: 'claude',
      type: 'persistent',
      mode: 'auto',
      discoverySource: 'discord',
    });
    bus.emit(SessionModeChanged, { sessionId: 's1', previousMode: 'auto', nextMode: 'monitor' });
    bus.emit(SessionEnded, { sessionId: 's1', channelId: 'c1', categoryId: 'cat1' });

    expect(created.mock.calls[0][0].payload.sessionId).toBe('s1');
    expect(modeChanged.mock.calls[0][0].payload.nextMode).toBe('monitor');
    expect(ended.mock.calls[0][0].payload.channelId).toBe('c1');
  });

  it('MonitorRunStarted / MonitorRunEnded carry sessionId + status', () => {
    const started = vi.fn();
    const ended = vi.fn();
    bus.on(MonitorRunStarted, started);
    bus.on(MonitorRunEnded, ended);

    bus.emit(MonitorRunStarted, { sessionId: 's1', runId: 'r1', goal: 'fix', maxIterations: 6 });
    bus.emit(MonitorRunEnded, { sessionId: 's1', runId: 'r1', status: 'abandoned', iteration: 3 });

    expect(started.mock.calls[0][0].payload.goal).toBe('fix');
    expect(ended.mock.calls[0][0].payload.status).toBe('abandoned');
  });

  it('middleware runs but does not block emission', async () => {
    const mid = vi.fn();
    bus.middleware(async (event) => {
      mid(event.type);
    });
    bus.emit(GateCreated, { gateId: 'm', sessionId: 's', provider: 'claude', isBlocking: false });
    // middleware is async; give it a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(mid).toHaveBeenCalledWith('gate.created');
  });
});

describe('StateMachine emits domain events (P3a integration)', () => {
  let bus: EventBus;

  beforeEach(async () => {
    bus = new EventBus();
    _setDomainBusForTest(bus);
    // 重要:state-machine 的 applyPlatformEvent 会读取 getDomainBus(),
    // 所以 import 必须在 bus 注入后发生,或者 module-scoped bus 要接受注入。
  });

  afterEach(() => {
    _setDomainBusForTest(null);
  });

  it('awaiting_human platform event triggers SessionAwaitingHuman', async () => {
    const handler = vi.fn();
    bus.on(SessionAwaitingHuman, handler);

    const { StateMachine } = await import('@workspacecord/state');
    const sm = new StateMachine();
    sm.applyPlatformEvent({
      type: 'awaiting_human',
      sessionId: 'sess-emit-1',
      source: 'claude',
      stateSource: 'formal',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { detail: '你确认要删除这个文件吗?' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.detail).toBe('你确认要删除这个文件吗?');
    expect(handler.mock.calls[0][0].payload.sessionId).toBe('sess-emit-1');
    sm.clearSession('sess-emit-1');
  });

  it('errored platform event triggers SessionErrored', async () => {
    const handler = vi.fn();
    bus.on(SessionErrored, handler);

    const { StateMachine } = await import('@workspacecord/state');
    const sm = new StateMachine();
    sm.applyPlatformEvent({
      type: 'errored',
      sessionId: 'sess-emit-2',
      source: 'codex',
      stateSource: 'formal',
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { errorMessage: 'provider exploded' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.errorMessage).toBe('provider exploded');
    sm.clearSession('sess-emit-2');
  });
});
