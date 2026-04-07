import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { config } from './config.ts';
import { isUserAllowed } from './utils.ts';
import {
  handleAwaitingHumanButton,
  handleCleanupButtons,
  handleContinueButton,
  handleDeprecatedInteractionButton,
  handleExpandButton,
  handleModeButton,
  handleSelectMenuAction,
  handleStopButton,
} from './button-handler-actions.ts';

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    console.warn(`[ButtonHandler] Unauthorized button press by user ${interaction.user.id}: ${interaction.customId}`);
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  if (await handleStopButton(interaction)) return;
  if (await handleAwaitingHumanButton(interaction)) return;
  if (await handleContinueButton(interaction)) return;
  if (await handleExpandButton(interaction)) return;
  if (await handleDeprecatedInteractionButton(interaction)) return;
  if (await handleCleanupButtons(interaction)) return;
  if (await handleModeButton(interaction)) return;

  await interaction.reply({ content: 'Unknown button.', ephemeral: true });
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: 'Not authorized.', ephemeral: true });
    return;
  }

  if (await handleSelectMenuAction(interaction)) return;

  await interaction.reply({ content: 'Unknown selection.', ephemeral: true });
}
