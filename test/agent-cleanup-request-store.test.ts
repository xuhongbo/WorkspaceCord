import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupExpiredRequests,
  createCleanupRequest,
  getCleanupRequest,
} from '../src/agent-cleanup-request-store.ts';

afterEach(() => {
  cleanupExpiredRequests(Number.MAX_SAFE_INTEGER);
  vi.useRealTimers();
});

describe('agent-cleanup-request-store', () => {
  it('getCleanupRequest 会在读取时淘汰过期请求', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));

    const request = createCleanupRequest({
      id: 'cleanup-expired',
      userId: 'user-1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'channel-1',
      candidateSessionIds: ['session-1'],
    });

    vi.setSystemTime(new Date('2026-04-01T00:11:00.000Z'));

    expect(getCleanupRequest(request.id)).toBeUndefined();
  });
});
