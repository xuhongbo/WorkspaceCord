import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export type ProviderName = 'claude' | 'codex';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted';

// ── Content blocks (provider-agnostic) ──────────────────────────

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
};
export type LocalImageBlock = { type: 'local_image'; path: string };
export type ContentBlock = TextBlock | ImageBlock | LocalImageBlock;

// ── Provider Events (the unified stream protocol) ───────────────

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; toolName: string; toolInput: string }
  | { type: 'tool_result'; toolName: string; result: string; isError?: boolean }
  | { type: 'ask_user'; questionsJson: string }
  | { type: 'task'; action: string; dataJson: string }
  | { type: 'task_started'; taskId: string; description: string }
  | {
      type: 'task_progress';
      taskId: string;
      description: string;
      lastToolName?: string;
      summary?: string;
    }
  | {
      type: 'task_done';
      taskId: string;
      status: 'completed' | 'failed' | 'stopped';
      summary: string;
    }
  | { type: 'image_file'; filePath: string }
  | {
      type: 'command_execution';
      command: string;
      output: string;
      exitCode: number | null;
      status: string;
    }
  | {
      type: 'file_change';
      changes: Array<{ filePath: string; changeKind: 'add' | 'update' | 'delete' }>;
    }
  | { type: 'web_search'; query: string }
  | { type: 'reasoning'; text: string }
  | { type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { type: 'session_init'; providerSessionId: string }
  | {
      type: 'result';
      success: boolean;
      costUsd: number;
      durationMs: number;
      numTurns: number;
      errors: string[];
      metadata?: { sessionEnd?: boolean };
    }
  | { type: 'error'; message: string };

// ── Provider Interface ──────────────────────────────────────────

export type ClaudePermissionMode = 'bypass' | 'normal';

export interface ProviderPermissionContext {
  signal: AbortSignal;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseID: string;
  agentID?: string;
}

export type ProviderPermissionDecision =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };

export type ProviderCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  context: ProviderPermissionContext,
) => Promise<ProviderPermissionDecision>;

/** Base options shared by all providers. */
export interface BaseProviderOptions {
  directory: string;
  providerSessionId?: string;
  model?: string;
  systemPromptParts: string[];
  abortController: AbortController;
  canUseTool?: ProviderCanUseTool;
}

/** Claude-specific options. */
export interface ClaudeProviderOptions extends BaseProviderOptions {
  claudePermissionMode?: ClaudePermissionMode;
}

/** Codex-specific options. */
export interface CodexProviderOptions extends BaseProviderOptions {
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  networkAccessEnabled?: boolean;
  webSearchMode?: 'disabled' | 'cached' | 'live';
  modelReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

/** Union type for backward compatibility — callers can pass any provider's options. */
export type ProviderSessionOptions = ClaudeProviderOptions & CodexProviderOptions;

export interface Provider {
  readonly name: ProviderName;

  sendPrompt(
    prompt: string | ContentBlock[],
    options: ProviderSessionOptions,
  ): AsyncGenerator<ProviderEvent>;

  continueSession(options: ProviderSessionOptions): AsyncGenerator<ProviderEvent>;

  supports(feature: string): boolean;
}
