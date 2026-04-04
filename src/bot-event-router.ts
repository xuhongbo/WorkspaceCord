import { InteractionType, type Interaction, type Message } from 'discord.js';

export interface CommandHandlers {
  handleProject: (interaction: never) => Promise<void>;
  handleAgent: (interaction: never) => Promise<void>;
  handleSubagent: (interaction: never) => Promise<void>;
  handleShell: (interaction: never) => Promise<void>;
  handleSpawnShortcut: (interaction: never) => Promise<void>;
  handleStopShortcut: (interaction: never) => Promise<void>;
  handleEndShortcut: (interaction: never) => Promise<void>;
  handleRunShortcut: (interaction: never) => Promise<void>;
  handleButton: (interaction: never) => Promise<void>;
  handleSelectMenu: (interaction: never) => Promise<void>;
  handleMessage: (message: Message) => Promise<void>;
}

export class BotEventRouter {
  constructor(private handlers: CommandHandlers) {}

  async routeInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.type === InteractionType.ApplicationCommand && interaction.isChatInputCommand()) {
        const h = this.handlers;
        switch (interaction.commandName) {
          case 'project': return await h.handleProject(interaction as never);
          case 'agent': return await h.handleAgent(interaction as never);
          case 'subagent': return await h.handleSubagent(interaction as never);
          case 'shell': return await h.handleShell(interaction as never);
          case 'spawn': return await h.handleSpawnShortcut(interaction as never);
          case 'stop': return await h.handleStopShortcut(interaction as never);
          case 'end': return await h.handleEndShortcut(interaction as never);
          case 'run': return await h.handleRunShortcut(interaction as never);
        }
      }
      if (interaction.isButton()) return await this.handlers.handleButton(interaction as never);
      if (interaction.isStringSelectMenu()) return await this.handlers.handleSelectMenu(interaction as never);
    } catch (err) {
      console.error('Interaction error:', err);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An error occurred.', ephemeral: true });
        }
      } catch {
        /* can't recover */
      }
    }
  }

  async routeMessage(message: Message): Promise<void> {
    await this.handlers.handleMessage(message);
  }
}
