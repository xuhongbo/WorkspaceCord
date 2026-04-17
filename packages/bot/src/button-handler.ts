import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
import { routeButton, routeSelectMenu } from './button-router.ts';

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  await routeButton(interaction);
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  await routeSelectMenu(interaction);
}
