// 统一状态机单元测试
// 验证三层状态模型的转换规则、幂等性和非法转换拒绝

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateMachine } from '../src/state/state-machine.js';
import type {
  SessionLifecycle,
  ExecutionState,
  GateStatus,
} from '../src/state/state-machine.js';

describe('StateMachine - 三层状态模型', () => {
  let sm: StateMachine;

  beforeEach(() => {
    sm = new StateMachine();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getState', () => {
    it('应该为新会话创建默认状态', () => {
      const state = sm.getState('session-1');
      expect(state.lifecycle).toBe('initializing');
      expect(state.execution).toBeNull();
      expect(state.gate).toBeNull();
    });

    it('应该返回已存在的会话状态', () => {
      sm.transition('session-1', 'init', { lifecycle: 'active', execution: 'idle' });
      const state = sm.getState('session-1');
      expect(state.lifecycle).toBe('active');
      expect(state.execution).toBe('idle');
    });
  });

  describe('transition - 生命周期转换', () => {
    it('应该允许合法的生命周期转换', () => {
      // initializing -> active
      const result1 = sm.transition('session-1', 'start', { lifecycle: 'active' });
      expect(result1.success).toBe(true);
      expect(result1.state.lifecycle).toBe('active');

      // active -> waiting_human
      const result2 = sm.transition('session-1', 'ask_user', { lifecycle: 'waiting_human' });
      expect(result2.success).toBe(true);
      expect(result2.state.lifecycle).toBe('waiting_human');

      // waiting_human -> active
      const result3 = sm.transition('session-1', 'user_replied', { lifecycle: 'active' });
      expect(result3.success).toBe(true);
      expect(result3.state.lifecycle).toBe('active');

      // active -> completed
      const result4 = sm.transition('session-1', 'finish', { lifecycle: 'completed' });
      expect(result4.success).toBe(true);
      expect(result4.state.lifecycle).toBe('completed');
    });

    it('应该拒绝非法的生命周期转换', () => {
      // initializing -> waiting_human (非法)
      const result = sm.transition('session-1', 'invalid', { lifecycle: 'waiting_human' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('非法生命周期转换');
      expect(result.state.lifecycle).toBe('initializing');
    });

    it('应该允许从 error 恢复到 active', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active' });
      sm.transition('session-1', 'error', { lifecycle: 'error' });
      const result = sm.transition('session-1', 'recover', { lifecycle: 'active' });
      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('active');
    });

    it('应该允许从 completed 重新激活到 active', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active' });
      sm.transition('session-1', 'finish', { lifecycle: 'completed' });
      const result = sm.transition('session-1', 'restart', { lifecycle: 'active' });
      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('active');
    });
  });

  describe('transition - 执行状态转换', () => {
    beforeEach(() => {
      // 先激活会话
      sm.transition('session-1', 'start', { lifecycle: 'active', execution: 'idle' });
    });

    it('应该允许合法的执行状态转换', () => {
      // idle -> thinking
      const result1 = sm.transition('session-1', 'think', { execution: 'thinking' });
      expect(result1.success).toBe(true);
      expect(result1.state.execution).toBe('thinking');

      // thinking -> tool_executing
      const result2 = sm.transition('session-1', 'exec', { execution: 'tool_executing' });
      expect(result2.success).toBe(true);
      expect(result2.state.execution).toBe('tool_executing');

      // tool_executing -> streaming_output
      const result3 = sm.transition('session-1', 'stream', { execution: 'streaming_output' });
      expect(result3.success).toBe(true);
      expect(result3.state.execution).toBe('streaming_output');

      // streaming_output -> idle
      const result4 = sm.transition('session-1', 'done', { execution: 'idle' });
      expect(result4.success).toBe(true);
      expect(result4.state.execution).toBe('idle');
    });

    it('应该拒绝非法的执行状态转换', () => {
      // idle -> streaming_output (跳过 thinking/tool_executing)
      sm.transition('session-1', 'reset', { execution: 'idle' });
      const result = sm.transition('session-1', 'invalid', { execution: 'streaming_output' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('非法执行状态转换');
    });

    it('应该拒绝在非 active 状态下设置执行状态', () => {
      sm.transition('session-1', 'pause', { lifecycle: 'paused' });
      const result = sm.transition('session-1', 'invalid', { execution: 'thinking' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('执行状态仅在 lifecycle=active 时有效');
    });

    it('应该在 lifecycle 离开 active 时自动清理执行状态', () => {
      sm.transition('session-1', 'think', { execution: 'thinking' });
      const result = sm.transition('session-1', 'pause', { lifecycle: 'paused' });
      expect(result.success).toBe(true);
      expect(result.state.lifecycle).toBe('paused');
      expect(result.state.execution).toBeNull();
    });
  });

  describe('transition - 门控状态转换', () => {
    it('应该允许独立管理门控状态', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active' });

      // 创建门控
      const result1 = sm.transition('session-1', 'gate_created', { gate: 'pending' });
      expect(result1.success).toBe(true);
      expect(result1.state.gate).toBe('pending');

      // 批准门控
      const result2 = sm.transition('session-1', 'gate_approved', { gate: 'approved' });
      expect(result2.success).toBe(true);
      expect(result2.state.gate).toBe('approved');

      // 清除门控
      const result3 = sm.transition('session-1', 'gate_cleared', { gate: null });
      expect(result3.success).toBe(true);
      expect(result3.state.gate).toBeNull();
    });

    it('门控状态不应影响生命周期和执行状态', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active', execution: 'idle' });
      sm.transition('session-1', 'gate', { gate: 'pending' });

      const state = sm.getState('session-1');
      expect(state.lifecycle).toBe('active');
      expect(state.execution).toBe('idle');
      expect(state.gate).toBe('pending');
    });
  });

  describe('transition - 幂等性', () => {
    it('相同状态的重复转换应该成功且不改变状态', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active' });

      const result1 = sm.transition('session-1', 'noop', { lifecycle: 'active' });
      expect(result1.success).toBe(true);

      const result2 = sm.transition('session-1', 'noop', { lifecycle: 'active' });
      expect(result2.success).toBe(true);

      const history = sm.getTransitionHistory('session-1');
      // 只有第一次 start 会被记录，后续幂等操作不记录
      expect(history.length).toBe(1);
    });

    it('执行状态的幂等转换', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active', execution: 'idle' });

      const result1 = sm.transition('session-1', 'noop', { execution: 'idle' });
      expect(result1.success).toBe(true);

      const result2 = sm.transition('session-1', 'noop', { execution: 'idle' });
      expect(result2.success).toBe(true);

      const state = sm.getState('session-1');
      expect(state.execution).toBe('idle');
    });
  });

  describe('getTransitionHistory', () => {
    it('应该记录所有状态转换', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active' });
      sm.transition('session-1', 'think', { execution: 'idle' });
      sm.transition('session-1', 'pause', { lifecycle: 'paused' });

      const history = sm.getTransitionHistory('session-1');
      expect(history.length).toBe(3);
      expect(history[0].event).toBe('start');
      expect(history[1].event).toBe('think');
      expect(history[2].event).toBe('pause');
    });

    it('应该限制历史记录数量为 100 条', () => {
      for (let i = 0; i < 150; i++) {
        sm.transition('session-1', `event-${i}`, {
          lifecycle: i % 2 === 0 ? 'active' : 'paused',
        });
      }

      const history = sm.getTransitionHistory('session-1');
      expect(history.length).toBe(100);
    });
  });

  describe('clearSession', () => {
    it('应该清理会话状态和历史', () => {
      sm.transition('session-1', 'start', { lifecycle: 'active' });
      sm.clearSession('session-1');

      const state = sm.getState('session-1');
      expect(state.lifecycle).toBe('initializing'); // 重新创建默认状态

      const history = sm.getTransitionHistory('session-1');
      expect(history.length).toBe(0);
    });
  });

  describe('applyPlatformEvent - session_idle 防止过期计时器回写', () => {
    it('应该忽略离开 completed 后的延迟 session_idle 事件', () => {
      vi.useFakeTimers();
      const sessionId = 'session-idle-guard';

      sm.incrementTurn(sessionId);
      sm.applyPlatformEvent({
        type: 'completed',
        sessionId,
        source: 'codex',
        confidence: 'high',
        timestamp: Date.now(),
      });

      sm.applyPlatformEvent({
        type: 'session_ended',
        sessionId,
        source: 'codex',
        confidence: 'high',
        timestamp: Date.now(),
      });

      vi.advanceTimersByTime(3000);

      expect(sm.getSession(sessionId)?.state).toBe('offline');
    });

    it('应该拒绝没有有效 token 的外部 session_idle 事件', () => {
      const sessionId = 'session-idle-no-token';

      sm.incrementTurn(sessionId);
      sm.applyPlatformEvent({
        type: 'thinking_started',
        sessionId,
        source: 'codex',
        confidence: 'high',
        timestamp: Date.now(),
      });

      sm.applyPlatformEvent({
        type: 'session_idle',
        sessionId,
        source: 'codex',
        confidence: 'high',
        timestamp: Date.now(),
      });

      expect(sm.getSession(sessionId)?.state).toBe('thinking');
    });
  });
});
