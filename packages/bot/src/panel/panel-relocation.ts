// 面板重定位：将状态卡和摘要消息整体重新发送到频道底部。
// 从 panel-adapter.ts 抽出，原 relocateSessionPanelToBottom 及其超时兜底逻辑。

import type { SessionChannel } from '../discord-types.ts';
import { setStatusCardBinding } from '@workspacecord/engine/session-registry';
import { getSessionView } from '@workspacecord/engine/session-context';
import { getPanel } from './panel-state.ts';

const RELOCATION_TIMEOUT_MS = 15_000;

export async function relocateSessionPanelToBottom(
  sessionId: string,
  channel: SessionChannel | undefined,
  initialize: (sessionId: string, channel: SessionChannel, options: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  let panel = getPanel(sessionId);
  if (!panel && channel) {
    const session = getSessionView(sessionId);
    const initPromise = initialize(sessionId, channel, {
      statusCardMessageId: session?.statusCardMessageId,
      initialTurn: session?.currentTurn || 1,
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Panel initialization timeout')),
        RELOCATION_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([initPromise, timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    panel = getPanel(sessionId);
  }
  if (!panel) return;

  let statusRelocation:
    | {
        oldMessageId?: string;
        newMessageId: string;
      }
    | null = null;

  try {
    statusRelocation = await panel.statusCard.recreateAtBottom();
  } catch (error) {
    console.warn(`状态消息迁移失败 (${sessionId})：`, error);
    return;
  }

  let digestRelocation = { oldMessageIds: [] as string[], newMessageIds: [] as string[] };
  try {
    digestRelocation = await panel.summaryHandler.relocateDigestToBottom();
  } catch (error) {
    console.warn(`摘要消息迁移失败 (${sessionId})：`, error);
    if (statusRelocation?.oldMessageId && statusRelocation.newMessageId) {
      panel.statusCard.adopt(statusRelocation.oldMessageId);
      await panel.channel.messages
        .delete(statusRelocation.newMessageId)
        .catch((e) =>
          console.warn(
            `[PanelAdapter] Failed to cleanup new status card (${sessionId}): ${(e as Error).message}`,
          ),
        );
    }
    return;
  }

  if (statusRelocation?.newMessageId) {
    setStatusCardBinding(sessionId, { messageId: statusRelocation.newMessageId });
  }

  if (statusRelocation?.oldMessageId) {
    await panel.channel.messages
      .delete(statusRelocation.oldMessageId)
      .catch((e) =>
        console.warn(
          `[PanelAdapter] Failed to delete old status card (${sessionId}): ${(e as Error).message}`,
        ),
      );
  }
  for (const messageId of digestRelocation.oldMessageIds) {
    await panel.channel.messages
      .delete(messageId)
      .catch((e) =>
        console.warn(
          `[PanelAdapter] Failed to delete old digest (${sessionId}): ${(e as Error).message}`,
        ),
      );
  }
}
