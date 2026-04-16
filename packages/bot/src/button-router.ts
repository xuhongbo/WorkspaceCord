// 按钮与下拉菜单的声明式路由
// 取代过去分散在 button-handler.ts 中的 if-return 链；新增按钮只需在 routes 中添加一行。
// 每个路由是一个 handler，自己内部对 customId 做前缀匹配并返回是否处理；
// 这里只负责顺序调用和统一的权限/兜底。

import type { ButtonInteraction, StringSelectMenuInteraction } from 'discord.js';
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

export type ButtonRoute = (interaction: ButtonInteraction) => Promise<boolean>;
export type SelectRoute = (interaction: StringSelectMenuInteraction) => Promise<boolean>;

const BUTTON_ROUTES: ButtonRoute[] = [
  handleStopButton,
  handleAwaitingHumanButton,
  handleContinueButton,
  handleExpandButton,
  handleDeprecatedInteractionButton,
  handleCleanupButtons,
  handleModeButton,
];

const SELECT_ROUTES: SelectRoute[] = [handleSelectMenuAction];

async function checkAuthorization(
  userId: string,
  reply: (content: string) => Promise<unknown>,
): Promise<boolean> {
  if (isUserAllowed(userId, config.allowedUsers, config.allowAllUsers)) return true;
  await reply('未授权。');
  return false;
}

export async function routeButton(interaction: ButtonInteraction): Promise<void> {
  const ok = await checkAuthorization(interaction.user.id, (content) =>
    interaction.reply({ content, ephemeral: true }),
  );
  if (!ok) {
    console.warn(
      `[ButtonHandler] Unauthorized button press by user ${interaction.user.id}: ${interaction.customId}`,
    );
    return;
  }
  for (const route of BUTTON_ROUTES) {
    if (await route(interaction)) return;
  }
  await interaction.reply({ content: '未知按钮。', ephemeral: true });
}

export async function routeSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const ok = await checkAuthorization(interaction.user.id, (content) =>
    interaction.reply({ content, ephemeral: true }),
  );
  if (!ok) return;
  for (const route of SELECT_ROUTES) {
    if (await route(interaction)) return;
  }
  await interaction.reply({ content: '未知选择。', ephemeral: true });
}
