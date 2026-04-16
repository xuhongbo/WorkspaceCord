// 共享的会话面板存储与查找
// 所有 panel-* 子模块都从这里读/写；避免多处复制 Map 或产生循环依赖。

import { SessionPanelComponent } from '../discord/session-panel-component.ts';

const sessionPanels = new Map<string, SessionPanelComponent>();
const sessionInitializationPromises = new Map<string, Promise<void>>();

export function getPanel(sessionId: string): SessionPanelComponent | undefined {
  return sessionPanels.get(sessionId);
}

export function setPanel(sessionId: string, panel: SessionPanelComponent): void {
  sessionPanels.set(sessionId, panel);
}

export function deletePanel(sessionId: string): void {
  sessionPanels.delete(sessionId);
}

export function getAllPanels(): IterableIterator<[string, SessionPanelComponent]> {
  return sessionPanels.entries();
}

export function getPanelCount(): number {
  return sessionPanels.size;
}

export function getInitializationPromise(sessionId: string): Promise<void> | undefined {
  return sessionInitializationPromises.get(sessionId);
}

export function setInitializationPromise(sessionId: string, promise: Promise<void>): void {
  sessionInitializationPromises.set(sessionId, promise);
}

export function deleteInitializationPromise(sessionId: string): void {
  sessionInitializationPromises.delete(sessionId);
}
