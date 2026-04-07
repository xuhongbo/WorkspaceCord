import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusCardProjectionRenderer } from '../src/discord/status-card-projection-renderer.ts';

describe('StatusCardProjectionRenderer', () => {
  let renderer: StatusCardProjectionRenderer;

  beforeEach(() => {
    vi.useFakeTimers();
    renderer = new StatusCardProjectionRenderer();
  });

  it('renderNow forwards projection to statusCard.update', async () => {
    const update = vi.fn(async () => undefined);

    await renderer.renderNow(
      's1',
      {
        state: 'idle',
        stateSource: 'formal',
        confidence: 'high',
        updatedAt: 1,
        turn: 2,
        phase: '待命',
        humanResolved: false,
      },
      {
        statusCard: { update },
        remoteHumanControl: true,
        provider: 'codex',
        permissionsSummary: 'workspace-write',
      },
    );

    expect(update).toHaveBeenCalledWith('idle', expect.objectContaining({
      turn: 2,
      phase: '待命',
      provider: 'codex',
      permissionsSummary: 'workspace-write',
    }));
  });

  it('schedule coalesces multiple pending renders for the same session', async () => {
    const update = vi.fn(async () => undefined);
    const context = { statusCard: { update } };
    const first = {
      state: 'thinking',
      stateSource: 'formal',
      confidence: 'high',
      updatedAt: 1,
      turn: 1,
      phase: '思考中',
      humanResolved: false,
    } as const;
    const second = {
      state: 'working',
      stateSource: 'formal',
      confidence: 'high',
      updatedAt: 2,
      turn: 1,
      phase: '执行中',
      humanResolved: false,
    } as const;

    renderer.schedule('s1', first, context, 500);
    renderer.schedule('s1', second, context, 500);

    await vi.advanceTimersByTimeAsync(500);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('working', expect.objectContaining({ phase: '执行中' }));
  });
});
