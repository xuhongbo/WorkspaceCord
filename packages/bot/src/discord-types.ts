// Discord-specific type aliases — kept separate from @workspacecord/core types
// to avoid pulling discord.js into platform-agnostic packages

import type { TextChannel, AnyThreadChannel } from 'discord.js';

/** A Discord channel that hosts a session (text channel or thread). */
export type SessionChannel = TextChannel | AnyThreadChannel;
