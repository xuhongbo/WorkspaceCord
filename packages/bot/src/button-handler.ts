import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { config, isUserAllowed } from '@workspacecord/core';
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
    await interaction.reply({ content: '未授权。', ephemeral: true });
    return;
  }

  if (await handleStopButton(interaction)) return;
  if (await handleAwaitingHumanButton(interaction)) return;
  if (await handleContinueButton(interaction)) return;
  if (await handleExpandButton(interaction)) return;
  if (await handleDeprecatedInteractionButton(interaction)) return;
  if (await handleCleanupButtons(interaction)) return;
  if (await handleModeButton(interaction)) return;

  await interaction.reply({ content: '未知按钮。', ephemeral: true });
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    await interaction.reply({ content: '未授权。', ephemeral: true });
    return;
  }

  if (await handleSelectMenuAction(interaction)) return;

  await interaction.reply({ content: '未知选择。', ephemeral: true });
}
