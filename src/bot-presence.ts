import { Client, ActivityType } from 'discord.js';
import { getAllSessions } from './thread-manager.ts';

export class PresenceManager {
  constructor(private client: Client) {}

  updatePresence(): void {
    const all = getAllSessions();
    const generating = all.filter((s) => s.isGenerating).length;

    if (all.length === 0) {
      this.client.user?.setPresence({
        status: 'idle',
        activities: [{ name: 'No active agents', type: ActivityType.Custom }],
      });
    } else {
      const label = generating > 0 ? `${generating} generating` : `${all.length} agents`;
      this.client.user?.setPresence({
        status: 'online',
        activities: [{ name: label, type: ActivityType.Watching }],
      });
    }
  }

  clearPresence(): void {
    this.client.user?.setPresence({
      status: 'dnd' as const,
      activities: [],
    });
  }
}
