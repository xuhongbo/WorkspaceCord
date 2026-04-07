import type { Token } from './di-container.ts';

export function createToken<T>(name: string): Token<T> {
  return { symbol: Symbol.for(name) };
}

export interface ILogger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): ILogger;
}

export interface IEventBus {
  emit(event: string, payload: unknown): void;
  on(event: string, handler: (payload: unknown) => void): () => void;
  off(event: string, handler: (payload: unknown) => void): void;
}

export interface IServiceBus {
  register(name: string, handler: (payload: unknown) => Promise<unknown>): void;
  call<T = unknown>(name: string, payload?: unknown): Promise<T>;
}

export interface ISession {
  id: string;
  projectId: string;
  channelId?: string;
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'error';
  mode: 'auto' | 'plan' | 'normal' | 'monitor';
  provider: 'claude' | 'codex';
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface ISessionManager {
  createSession(projectId: string, options: { mode?: string; provider?: string; cwd?: string }): Promise<ISession>;
  endSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<ISession>;
  getSession(sessionId: string): Promise<ISession | undefined>;
  abortSession(sessionId: string): Promise<void>;
}

export interface ISessionLookup {
  findByChannel(channelId: string): Promise<ISession | undefined>;
  findByProject(projectId: string): Promise<ISession[]>;
  findByStatus(status: ISession['status']): Promise<ISession[]>;
  all(): Promise<ISession[]>;
}

export interface IStateMachine {
  transition(sessionId: string, event: string, updates: Record<string, unknown>, metadata?: Record<string, unknown>): { success: boolean; state: unknown; error?: string };
  getState(sessionId: string): unknown;
  getSnapshot(sessionId: string): unknown;
  getPanelProjection(sessionId: string): unknown;
  applyPlatformEvent(event: unknown): unknown;
  advanceTurnToIdle(sessionId: string): unknown;
}

export interface IProjectConfig {
  id: string;
  name: string;
  cwd: string;
  personality?: string;
  skills?: string[];
  mcpServers?: Record<string, unknown>;
  defaultMode?: string;
  defaultProvider?: string;
}

export interface IProjectManager {
  registerProject(config: Omit<IProjectConfig, 'id'> & { id?: string }): Promise<IProjectConfig>;
  getProject(id: string): Promise<IProjectConfig | undefined>;
  findByCwd(cwd: string): Promise<IProjectConfig | undefined>;
  updateProject(id: string, updates: Partial<IProjectConfig>): Promise<IProjectConfig>;
  removeProject(id: string): Promise<void>;
  listProjects(): Promise<IProjectConfig[]>;
}

export interface IProviderEvent {
  type: string;
  data?: unknown;
}

export interface IAgentExecutor {
  execute(sessionId: string, prompt: string): AsyncGenerator<IProviderEvent>;
  continue(sessionId: string): AsyncGenerator<IProviderEvent>;
  monitor(sessionId: string, maxIterations?: number): AsyncGenerator<IProviderEvent>;
  abort(sessionId: string): Promise<void>;
}

export interface IDiscordGateway {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export interface IDeliveryService {
  send(channelId: string, content: string): Promise<void>;
  edit(channelId: string, messageId: string, content: string): Promise<void>;
  reply(channelId: string, messageId: string, content: string): Promise<void>;
  sendEmbed(channelId: string, embed: Record<string, unknown>): Promise<void>;
  createActionRow(components: Record<string, unknown>[]): Record<string, unknown>;
}

export interface IHookServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  port(): number;
}

export interface IHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, { status: string; message?: string }>;
  uptime: number;
}

export interface IHealthMonitor {
  registerCheck(name: string, fn: () => Promise<{ status: string; message?: string }>): void;
  report(): Promise<IHealthStatus>;
}

export interface IConfig {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

// Token instances
export const LoggerToken = createToken<ILogger>('Logger');
export const EventBusToken = createToken<IEventBus>('EventBus');
export const ServiceBusToken = createToken<IServiceBus>('ServiceBus');
export const SessionManagerToken = createToken<ISessionManager>('SessionManager');
export const SessionLookupToken = createToken<ISessionLookup>('SessionLookup');
export const StateMachineToken = createToken<IStateMachine>('StateMachine');
export const ProjectManagerToken = createToken<IProjectManager>('ProjectManager');
export const AgentExecutorToken = createToken<IAgentExecutor>('AgentExecutor');
export const DiscordGatewayToken = createToken<IDiscordGateway>('DiscordGateway');
export const DeliveryServiceToken = createToken<IDeliveryService>('DeliveryService');
export const HookServerToken = createToken<IHookServer>('HookServer');
export const HealthMonitorToken = createToken<IHealthMonitor>('HealthMonitor');
export const ConfigToken = createToken<IConfig>('Config');
