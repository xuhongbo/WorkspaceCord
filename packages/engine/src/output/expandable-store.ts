import type { ExpandableContent } from '@workspacecord/core';

const expandableStore = new Map<string, ExpandableContent>();
let expandCounter = 0;

setInterval(
  () => {
    const now = Date.now();
    const TTL = 10 * 60 * 1000;
    for (const [key, val] of expandableStore) {
      if (now - val.createdAt > TTL) expandableStore.delete(key);
    }
  },
  5 * 60 * 1000,
);

export function getExpandableContent(id: string): string | undefined {
  return expandableStore.get(id)?.content;
}

export function storeExpandable(content: string): string {
  const id = `exp_${++expandCounter}`;
  expandableStore.set(id, { content, createdAt: Date.now() });
  return id;
}
