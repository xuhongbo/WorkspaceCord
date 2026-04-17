import { updateWorkflowState } from '../session-registry.ts';
import { getSessionView } from '../session-context.ts';
import { getOutputPort } from '../output-port.ts';
import type { ThreadSession as Session } from '@workspacecord/core';
import type { ContentBlock } from '@workspacecord/providers';

export function refreshSession(session: Session): Session {
  return getSessionView(session.id) ?? session;
}

export function applyWorkflowHook(
  session: Session,
  hook: Session['workflowState']['lastHook'],
  patch: Partial<Session['workflowState']> = {},
): Session {
  return updateWorkflowState(session.id, (current) => ({
    ...current,
    ...patch,
    lastHook: hook,
  })) ?? session;
}

export function extractPromptText(prompt: string | ContentBlock[]): string {
  if (typeof prompt === 'string') return prompt.trim();

  return prompt
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export async function updatePanelState(
  session: Session,
  type: 'work_started' | 'awaiting_human' | 'errored',
  channel?: unknown,
): Promise<void> {
  await getOutputPort().updateState(
    session.id,
    {
      type,
      sessionId: session.id,
      source: session.provider === 'codex' ? 'codex' : 'claude',
      confidence: 'high',
      timestamp: Date.now(),
    },
    channel ? { channel } : undefined,
  );
}
