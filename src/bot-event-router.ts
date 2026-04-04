import {
  InteractionType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type StringSelectMenuInteraction,
} from 'discord.js';

export interface CommandHandlers {
  handleProject: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleAgent: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleSubagent: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleShell: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleSpawnShortcut: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleStopShortcut: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleEndShortcut: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleRunShortcut: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleButton: (interaction: ButtonInteraction) => Promise<void>;
  handleSelectMenu: (interaction: StringSelectMenuInteraction) => Promise<void>;
  handleMessage: (message: Message) => Promise<void>;
}

export class BotEventRouter {
  constructor(private handlers: CommandHandlers) {}

  async routeInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.type === InteractionType.ApplicationCommand && interaction.isChatInputCommand()) {
        const h = this.handlers;
        switch (interaction.commandName) {
          case 'project': return await h.handleProject(interaction);
          case 'agent': return await h.handleAgent(interaction);
          case 'subagent': return await h.handleSubagent(interaction);
          case 'shell': return await h.handleShell(interaction);
          case 'spawn': return await h.handleSpawnShortcut(interaction);
          case 'stop': return await h.handleStopShortcut(interaction);
          case 'end': return await h.handleEndShortcut(interaction);
          case 'run': return await h.handleRunShortcut(interaction);
        }
      }
      if (interaction.isButton()) return await this.handlers.handleButton(interaction);
      if (interaction.isStringSelectMenu()) return await this.handlers.handleSelectMenu(interaction);
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
