import { randomUUID } from 'node:crypto';

export interface AgentCleanupRequest {
  id: string;
  userId: string;
  guildId: string;
  categoryId: string;
  currentChannelId: string;
  candidateSessionIds: string[];
  createdAt: number;
}

const REQUEST_TTL_MS = 10 * 60 * 1000;

const requests = new Map<string, AgentCleanupRequest>();
const activeCleanupCategoryIds = new Set<string>();

export function createCleanupRequest(
  input: Omit<AgentCleanupRequest, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): AgentCleanupRequest {
  cleanupExpiredRequests();
  const request: AgentCleanupRequest = {
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? Date.now(),
    userId: input.userId,
    guildId: input.guildId,
    categoryId: input.categoryId,
    currentChannelId: input.currentChannelId,
    candidateSessionIds: [...new Set(input.candidateSessionIds)],
  };
  requests.set(request.id, request);
  return request;
}

export function getCleanupRequest(id: string): AgentCleanupRequest | undefined {
  cleanupExpiredRequests();
  return requests.get(id);
}

export function deleteCleanupRequest(id: string): boolean {
  return requests.delete(id);
}

export function cleanupExpiredRequests(now = Date.now()): number {
  let removed = 0;
  for (const [id, request] of requests) {
    if (now - request.createdAt <= REQUEST_TTL_MS) continue;
    requests.delete(id);
    removed += 1;
  }
  return removed;
}

export function acquireCleanupLock(categoryId: string): boolean {
  if (activeCleanupCategoryIds.has(categoryId)) return false;
  activeCleanupCategoryIds.add(categoryId);
  return true;
}

export function releaseCleanupLock(categoryId: string): void {
  activeCleanupCategoryIds.delete(categoryId);
}
