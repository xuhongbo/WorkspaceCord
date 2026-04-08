// Session permission resolution — extracted from session-registry.ts

import { config } from '@workspacecord/core';
import type { ThreadSession } from '@workspacecord/core';

export function resolveEffectiveClaudePermissionMode(session: ThreadSession): 'bypass' | 'normal' {
  return session.mode === 'auto' ? 'bypass' : (session.claudePermissionMode ?? config.claudePermissionMode);
}

export function resolveEffectiveCodexOptions(session: ThreadSession): {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  networkAccessEnabled: boolean;
  webSearchMode: 'disabled' | 'cached' | 'live';
  bypass: boolean;
} {
  const bypass = session.codexBypass === true;
  if (bypass) {
    return {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      networkAccessEnabled: true,
      webSearchMode: 'live',
      bypass: true,
    };
  }

  return {
    sandboxMode: session.codexSandboxMode ?? config.codexSandboxMode,
    approvalPolicy:
      session.mode === 'auto'
        ? 'never'
        : (session.codexApprovalPolicy ?? config.codexApprovalPolicy),
    networkAccessEnabled: session.codexNetworkAccessEnabled ?? config.codexNetworkAccessEnabled,
    webSearchMode: session.codexWebSearchMode ?? config.codexWebSearchMode,
    bypass: false,
  };
}

export function getSessionPermissionSummary(session: ThreadSession): string {
  if (session.provider === 'claude') {
    return resolveEffectiveClaudePermissionMode(session);
  }

  const codex = resolveEffectiveCodexOptions(session);
  if (codex.bypass) return 'bypass';
  return `${codex.sandboxMode} | ${codex.approvalPolicy} | net:${codex.networkAccessEnabled ? 'on' : 'off'} | search:${codex.webSearchMode}`;
}

export function getSessionPermissionDetails(session: ThreadSession): string {
  if (session.provider === 'claude') {
    return `Claude: ${resolveEffectiveClaudePermissionMode(session)}`;
  }

  const codex = resolveEffectiveCodexOptions(session);
  return [
    `sandbox=${codex.sandboxMode}`,
    `approval=${codex.approvalPolicy}`,
    `bypass=${codex.bypass ? 'on' : 'off'}`,
    `network=${codex.networkAccessEnabled ? 'on' : 'off'}`,
    `search=${codex.webSearchMode}`,
  ].join(' | ');
}
