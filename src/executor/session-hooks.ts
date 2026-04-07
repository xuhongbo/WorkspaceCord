import * as sessions from '../thread-manager.ts';
import { updateSessionState } from '../panel-adapter.ts';
import type { ThreadSession as Session, SessionChannel } from '../types.ts';
import type { ContentBlock } from '../providers/types.ts';

export function refreshSession(session: Session): Session {
  return sessions.getSession(session.id) ?? session;
}

export function applyWorkflowHook(
  session: Session,
  hook: Session['workflowState']['lastHook'],
  patch: Partial<Session['workflowState']> = {},
): Session {
  sessions.updateWorkflowState(session.id, (current) => ({
    ...current,
    ...patch,
    lastHook: hook,
  }));
  return refreshSession(session);
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
  channel?: SessionChannel,
): Promise<void> {
  await updateSessionState(
    session.id,
    {
      type,
      sessionId: session.id,
      source: session.provider === 'codex' ? 'codex' : 'claude',
      confidence: 'high',
      timestamp: Date.now(),
    },
    channel ? { channel, sourceHint: session.provider } : { sourceHint: session.provider },
  );
}
