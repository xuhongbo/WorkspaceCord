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
  handleButton: (interaction: ButtonInteraction) => Promise<void>;
  handleSelectMenu: (interaction: StringSelectMenuInteraction) => Promise<void>;
  handleMessage: (message: Message) => Promise<void>;
}

export class BotEventRouter {
  private readonly handlers: CommandHandlers;

  constructor(handlers: CommandHandlers) {
    this.handlers = handlers;
  }

  async routeInteraction(interaction: Interaction): Promise<void> {
    // 丢弃 shard 重连期间积压的过期 interaction（createdTimestamp > 2.5s 前）
    if (Date.now() - interaction.createdTimestamp > 2500) {
      console.warn(`[Router] 丢弃过期 interaction (延迟 ${Date.now() - interaction.createdTimestamp}ms): ${interaction.isCommand() ? interaction.commandName : interaction.id}`);
      return;
    }

    try {
      if (interaction.type === InteractionType.ApplicationCommand && interaction.isChatInputCommand()) {
        const h = this.handlers;
        switch (interaction.commandName) {
          case 'project': return await h.handleProject(interaction);
          case 'agent': return await h.handleAgent(interaction);
          case 'subagent': return await h.handleSubagent(interaction);
          case 'shell': return await h.handleShell(interaction);
        }
      }
      if (interaction.isButton()) return await this.handlers.handleButton(interaction);
      if (interaction.isStringSelectMenu()) return await this.handlers.handleSelectMenu(interaction);
    } catch (err) {
      console.error('Interaction error:', err);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '发生错误。', ephemeral: true });
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
