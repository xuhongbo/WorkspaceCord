// 事件归一层：将不同 Provider 的事件统一为平台事件
// 参考：clawd-on-desk/agents/registry.js

import type { ProviderEvent } from '@workspacecord/providers';
import type { PlatformEvent, PlatformEventType, UnifiedState } from './types.ts';
import { PLATFORM_EVENT_TO_STATE } from './types.ts';

// Claude 事件映射
const CLAUDE_EVENT_MAP: Record<string, UnifiedState> = {
  session_init: 'idle',
  text_delta: 'thinking',
  tool_start: 'working',
  tool_result: 'working',
  ask_user: 'awaiting_human',
  result: 'completed',
  error: 'error',
};

export function normalizeClaudeEvent(
  event: ProviderEvent,
  sessionId: string,
): PlatformEvent | null {
  const state = CLAUDE_EVENT_MAP[event.type];
  if (!state) return null;

  const platformType = mapToPlatformType(event.type);
  if (!platformType) return null;

  return {
    type: platformType,
    sessionId,
    source: 'claude',
    stateSource: 'formal',
    confidence: 'high',
    metadata: event,
    timestamp: Date.now(),
  };
}

function mapToPlatformType(eventType: string): PlatformEventType | null {
  const mapping: Record<string, PlatformEventType> = {
    session_init: 'session_started',
    text_delta: 'thinking_started',
    tool_start: 'work_started',
    ask_user: 'awaiting_human',
    result: 'completed',
    error: 'errored',
  };
  return mapping[eventType] || null;
}

export function normalizeCodexEvent(
  eventKey: string,
  sessionId: string,
  extra: { cwd?: string; observedState?: string; monitorSessionId?: string },
): PlatformEvent | null {
  const byEvent = mapCodexToPlatformType(eventKey);
  const byState = mapCodexStateToPlatformType(extra.observedState);
  const preferStateOverride = extra.observedState === 'codex-permission';
  const platformType = preferStateOverride
    ? byState ?? byEvent
    : byEvent ?? byState;
  if (!platformType) return null;

  const isPermissionEvent =
    eventKey === 'codex-permission' || extra.observedState === 'codex-permission';
  const inferredFromState = Boolean(byState && !byEvent);
  const stateSource = isPermissionEvent || inferredFromState ? 'inferred' : 'formal';

  return {
    type: platformType,
    sessionId,
    source: 'codex',
    stateSource,
    confidence: isPermissionEvent ? 'medium' : 'high',
    metadata: { eventKey, ...extra },
    timestamp: Date.now(),
  };
}

function mapCodexToPlatformType(eventKey: string): PlatformEventType | null {
  const mapping: Record<string, PlatformEventType> = {
    'session_meta': 'session_started',
    'event_msg:task_started': 'thinking_started',
    'event_msg:user_message': 'thinking_started',
    'response_item:function_call': 'work_started',
    'response_item:custom_tool_call': 'work_started',
    'response_item:web_search_call': 'work_started',
    'event_msg:exec_command_start': 'work_started',
    'codex-permission': 'awaiting_human',
    'event_msg:task_complete': 'completed',
    'event_msg:context_compacted': 'compaction_started',
    'event_msg:turn_aborted': 'session_idle',
    'codex-turn-end': 'completed',
    'event_msg:error': 'errored',
    'stale-cleanup': 'session_ended',
  };
  return mapping[eventKey] || null;
}

function mapCodexStateToPlatformType(state: string | undefined): PlatformEventType | null {
  if (!state) return null;
  const mapping: Record<string, PlatformEventType> = {
    thinking: 'thinking_started',
    working: 'work_started',
    sweeping: 'compaction_started',
    'codex-permission': 'awaiting_human',
    attention: 'completed',
    idle: 'session_idle',
    error: 'errored',
    sleeping: 'session_ended',
  };
  return mapping[state] ?? null;
}

export function isPlatformEvent(input: unknown): input is PlatformEvent {
  if (!input || typeof input !== 'object') return false;
  const obj = input as Record<string, unknown>;
  if (typeof obj.type !== 'string') return false;
  if (typeof obj.sessionId !== 'string') return false;
  if (obj.source !== 'claude' && obj.source !== 'codex') return false;
  if (obj.confidence !== 'high' && obj.confidence !== 'medium' && obj.confidence !== 'low') {
    return false;
  }
  return typeof obj.timestamp === 'number';
}

export function toPlatformEvent(
  event: ProviderEvent | PlatformEvent,
  sessionId: string,
  source: 'claude' | 'codex' = 'claude',
): PlatformEvent | null {
  if (isPlatformEvent(event)) {
    return {
      ...event,
      sessionId: event.sessionId || sessionId,
      source: event.source || source,
      stateSource: event.stateSource ?? 'formal',
      timestamp: event.timestamp || Date.now(),
    };
  }

  if (source === 'codex') {
    return null;
  }
  return normalizeClaudeEvent(event, sessionId);
}

export function mapPlatformEventToState(type: PlatformEventType): UnifiedState | null {
  return PLATFORM_EVENT_TO_STATE[type] ?? null;
}
