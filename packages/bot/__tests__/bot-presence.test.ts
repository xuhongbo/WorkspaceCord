import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PresenceManager } from '../src/bot-presence.ts';
import { ActivityType } from 'discord.js';

vi.mock('@workspacecord/engine/session-registry', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()),
  getAllSessions: vi.fn(),
}));

const { getAllSessions } = await import('@workspacecord/engine/session-registry');

describe('PresenceManager', () => {
  let manager: PresenceManager;
  let mockClient: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      user: {
        setPresence: vi.fn(),
      },
    };
    manager = new PresenceManager(mockClient);
  });

  describe('updatePresence', () => {
    it('sets idle presence when no sessions', () => {
      (getAllSessions as any).mockReturnValue([]);

      manager.updatePresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'idle',
        activities: [{ name: 'No active agents', type: ActivityType.Custom }],
      });
    });

    it('shows agent count when sessions exist', () => {
      (getAllSessions as any).mockReturnValue([
        { id: 's1', isGenerating: false },
        { id: 's2', isGenerating: false },
      ]);

      manager.updatePresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'online',
        activities: [{ name: '2 agents', type: ActivityType.Watching }],
      });
    });

    it('shows generating count when sessions are generating', () => {
      (getAllSessions as any).mockReturnValue([
        { id: 's1', isGenerating: true },
        { id: 's2', isGenerating: false },
      ]);

      manager.updatePresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'online',
        activities: [{ name: '1 generating', type: ActivityType.Watching }],
      });
    });
  });

  describe('clearPresence', () => {
    it('sets dnd status with no activities', () => {
      manager.clearPresence();

      expect(mockClient.user.setPresence).toHaveBeenCalledWith({
        status: 'dnd',
        activities: [],
      });
    });
  });
});
