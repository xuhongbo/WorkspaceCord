// ── Event Type Branded Types ──────────────────────────────────────────────────

export type EventType<T = unknown> = string & { readonly __payload: T };

export type EventHandler<T = unknown> = (event: AppEvent<T>) => void | Promise<void>;

export type EventMiddleware = (event: AppEvent) => void | Promise<void>;

// ── EventMap: maps event type strings to payload types ────────────────────────

export interface EventMap {
  'session.created': SessionCreatedPayload;
  'session.ended': SessionEndedPayload;
  'session.state_changed': SessionStateChangedPayload;
  'message.received': MessageReceivedPayload;
  'message.sent': MessageSentPayload;
  'agent.started': AgentStartedPayload;
  'agent.completed': AgentCompletedPayload;
  'agent.error': AgentErrorPayload;
  'gate.created': GateCreatedPayload;
  'gate.resolved': GateResolvedPayload;
  'gate.expired': GateExpiredPayload;
  'discord.ready': DiscordReadyPayload;
  'discord.reconnect': DiscordReconnectPayload;
}

// ── Base Event ────────────────────────────────────────────────────────────────

export interface AppEvent<T = unknown> {
  type: string;
  payload: T;
  traceId: string;
  timestamp: number;
  source: string;
}

// ── Session Events ────────────────────────────────────────────────────────────

export interface SessionCreatedPayload {
  sessionId: string;
  provider: string;
  channelId: string;
  categoryId: string;
  projectName: string;
  directory: string;
}

export interface SessionEndedPayload {
  sessionId: string;
  reason: string;
}

export interface SessionStateChangedPayload {
  sessionId: string;
  from: string;
  to: string;
}

// ── Message Events ────────────────────────────────────────────────────────────

export interface MessageReceivedPayload {
  sessionId: string;
  channelId: string;
  messageId: string;
  userId: string;
  text: string;
  attachments: string[];
}

export interface MessageSentPayload {
  sessionId: string;
  channelId: string;
  messageId: string;
  text: string;
}

// ── Agent Events ──────────────────────────────────────────────────────────────

export interface AgentStartedPayload {
  sessionId: string;
  prompt: string;
  mode: string;
}

export interface AgentCompletedPayload {
  sessionId: string;
  durationMs: number;
  costUsd: number;
}

export interface AgentErrorPayload {
  sessionId: string;
  error: Error | string;
}

// ── Gate Events ───────────────────────────────────────────────────────────────

export interface GateCreatedPayload {
  gateId: string;
  sessionId: string;
  type: string;
  isBlocking: boolean;
}

export interface GateResolvedPayload {
  gateId: string;
  action: string;
  resolvedBy: string;
}

export interface GateExpiredPayload {
  gateId: string;
}

// ── Discord Events ────────────────────────────────────────────────────────────

export interface DiscordReadyPayload {
  tag: string;
  guildId: string;
}

export interface DiscordReconnectPayload {
  shardId: number;
}
