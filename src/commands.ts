import { REST, Routes } from 'discord.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { buildProjectCommand } from './command-definitions/project-command.ts';
import { buildAgentCommand } from './command-definitions/agent-command.ts';
import { buildSubagentCommand } from './command-definitions/subagent-command.ts';
import { buildShellCommand } from './command-definitions/shell-command.ts';

const commands = [
  buildProjectCommand(),
  buildAgentCommand(),
  buildSubagentCommand(),
  buildShellCommand(),
];


export function getCommandDefinitions() {
  return commands.map((command) => command.toJSON());
}

const HASH_FILE = join(config.dataDir, 'commands-hash.txt');

function computeCommandsHash(body: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function readStoredHash(): string | null {
  try {
    if (existsSync(HASH_FILE)) {
      return readFileSync(HASH_FILE, 'utf-8').trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function writeStoredHash(hash: string): void {
  try {
    writeFileSync(HASH_FILE, hash, 'utf-8');
  } catch {
    /* ignore */
  }
}

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = getCommandDefinitions();

  const currentHash = computeCommandsHash(body);
  const storedHash = readStoredHash();

  if (currentHash === storedHash) {
    console.log(`[commands] ${body.length} commands unchanged, skipping registration`);
    return;
  }

  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body });
    console.log(`[commands] Registered ${body.length} guild commands`);
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body });
    console.log(`[commands] Registered ${body.length} global commands`);
  }

  writeStoredHash(currentHash);
}
