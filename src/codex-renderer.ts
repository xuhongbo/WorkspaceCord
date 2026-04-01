import { EmbedBuilder } from 'discord.js';
import type { ProviderEvent } from './providers/types.ts';
import { truncate } from './utils.ts';

type CommandExecutionEvent = Extract<ProviderEvent, { type: 'command_execution' }>;
type FileChangeEvent = Extract<ProviderEvent, { type: 'file_change' }>;
type ReasoningEvent = Extract<ProviderEvent, { type: 'reasoning' }>;
type TodoListEvent = Extract<ProviderEvent, { type: 'todo_list' }>;

export function renderCommandExecutionEmbed(event: CommandExecutionEvent): EmbedBuilder {
  const statusEmoji =
    event.status === 'completed'
      ? event.exitCode === 0
        ? '\u2705'
        : '\u274C'
      : event.status === 'failed'
        ? '\u274C'
        : '\uD83D\uDD04';

  const embed = new EmbedBuilder()
    .setColor(event.exitCode === 0 ? 0x2ecc71 : event.status === 'failed' ? 0xe74c3c : 0xf39c12)
    .setTitle(`${statusEmoji} Command`);

  embed.setDescription(`\`\`\`bash\n$ ${truncate(event.command, 900)}\n\`\`\``);

  if (event.output) {
    embed.addFields({
      name: 'Output',
      value: `\`\`\`\n${truncate(event.output, 900)}\n\`\`\``,
    });
  }

  if (event.exitCode !== null) {
    embed.setFooter({ text: `Exit code: ${event.exitCode}` });
  }

  return embed;
}

export function renderFileChangesEmbed(event: FileChangeEvent): EmbedBuilder {
  const kindEmoji: Record<string, string> = { add: '+', update: '~', delete: '-' };

  const lines = event.changes.map((c) => `${kindEmoji[c.changeKind] || '?'} ${c.filePath}`);

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('\uD83D\uDCC1 Files Changed')
    .setDescription(`\`\`\`diff\n${truncate(lines.join('\n'), 3900)}\n\`\`\``);
}

export function renderReasoningEmbed(event: ReasoningEvent): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('\uD83E\uDDE0 Reasoning')
    .setDescription(truncate(event.text, 4000));
}

export function renderCodexTodoListEmbed(event: TodoListEvent): EmbedBuilder {
  const lines = event.items
    .map((item) => `${item.completed ? '\u2705' : '\u2B1C'} ${item.text}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('\uD83D\uDCCB Task List')
    .setDescription(truncate(lines, 4000));
}
