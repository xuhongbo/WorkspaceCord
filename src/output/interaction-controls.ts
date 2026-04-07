import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import { truncate } from '../utils.ts';
import { clearPendingAnswers, setQuestionCount } from './answer-store.ts';

export function makeStopButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`stop:${sessionId}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger),
  );
}

export function makeOptionButtons(
  sessionId: string,
  options: string[],
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const maxOptions = Math.min(options.length, 10);
  for (let i = 0; i < maxOptions; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const chunk = options.slice(i, i + 5);
    for (let j = 0; j < chunk.length; j++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`option:${sessionId}:${i + j}`)
          .setLabel(truncate(chunk[j], 80))
          .setStyle(ButtonStyle.Secondary),
      );
    }
    rows.push(row);
  }
  return rows;
}

export function resolveEffectiveClaudePermissionMode(
  currentMode: string,
  claudePermissionMode?: 'bypass' | 'normal',
): 'bypass' | 'normal' | undefined {
  if (!claudePermissionMode) return undefined;
  return currentMode === 'auto' ? 'bypass' : claudePermissionMode;
}

export function makeModeButtons(
  sessionId: string,
  currentMode: string,
  claudePermissionMode?: 'bypass' | 'normal',
): ActionRowBuilder<ButtonBuilder> {
  const modes = [
    { id: 'auto', label: '⚡ 自动模式' },
    { id: 'plan', label: '📋 计划模式' },
    { id: 'normal', label: '🛡️ 普通模式' },
    { id: 'monitor', label: '🧠 监控模式' },
  ];

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const m of modes) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`mode:${sessionId}:${m.id}`)
        .setLabel(m.label)
        .setStyle(m.id === currentMode ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(m.id === currentMode),
    );
  }

  const effectiveClaudePermissionMode = resolveEffectiveClaudePermissionMode(
    currentMode,
    claudePermissionMode,
  );
  if (effectiveClaudePermissionMode) {
    const permLabel = effectiveClaudePermissionMode === 'bypass' ? '⚡ 绕过权限' : '🛡️ 需要确认';
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-info:${sessionId}`)
        .setLabel(permLabel)
        .setStyle(
          effectiveClaudePermissionMode === 'bypass' ? ButtonStyle.Danger : ButtonStyle.Success,
        )
        .setDisabled(true),
    );
  }

  return row;
}

export function makeYesNoButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm:${sessionId}:yes`)
      .setLabel('Yes')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`confirm:${sessionId}:no`)
      .setLabel('No')
      .setStyle(ButtonStyle.Danger),
  );
}

export function renderAskUserQuestion(
  questionsJson: string,
  sessionId: string,
): {
  embeds: import('discord.js').EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} | null {
  try {
    const data = JSON.parse(questionsJson);
    const questions: Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> = data.questions;
    if (!questions?.length) return null;

    const embeds: import('discord.js').EmbedBuilder[] = [];
    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
    const isMulti = questions.length > 1;
    if (isMulti) {
      clearPendingAnswers(sessionId);
      setQuestionCount(sessionId, questions.length);
    }

    const btnPrefix = isMulti ? 'pick' : 'answer';
    const selectPrefix = isMulti ? 'pick-select' : 'answer-select';

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const embed = new EmbedBuilder()
        .setColor(0xf39c12)
        .setTitle(q.header || 'Question')
        .setDescription(q.question);

      if (q.options?.length) {
        if (q.options.length <= 4) {
          const row = new ActionRowBuilder<ButtonBuilder>();
          for (let i = 0; i < q.options.length; i++) {
            row.addComponents(
              new ButtonBuilder()
                .setCustomId(`${btnPrefix}:${sessionId}:${qi}:${q.options[i].label}`)
                .setLabel(q.options[i].label.slice(0, 80))
                .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
            );
          }
          components.push(row);
        } else {
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`${selectPrefix}:${sessionId}:${qi}`)
            .setPlaceholder('Select an option...');
          for (const opt of q.options) {
            menu.addOptions({
              label: opt.label.slice(0, 100),
              description: opt.description?.slice(0, 100),
              value: opt.label,
            });
          }
          components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu));
        }
        const optionLines = q.options
          .map((o) => (o.description ? `**${o.label}** — ${o.description}` : `**${o.label}**`))
          .join('\n');
        embed.addFields({ name: 'Options', value: truncate(optionLines, 1000) });
      }
      embeds.push(embed);
    }

    if (isMulti) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`submit-answers:${sessionId}`)
            .setLabel('Submit Answers')
            .setStyle(ButtonStyle.Success),
        ),
      );
    }

    return { embeds, components };
  } catch {
    return null;
  }
}

export function shouldSuppressCommandExecution(command: string): boolean {
  return command.toLowerCase().includes('total-recall');
}


const STATUS_EMOJI: Record<string, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  deleted: '🗑️',
};

export function renderTaskToolEmbed(action: string, dataJson: string): EmbedBuilder | null {
  try {
    const data = JSON.parse(dataJson);
    if (action === 'TaskCreate') {
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📋 New Task')
        .setDescription(`**${data.subject || 'Untitled'}**`);
      if (data.description) {
        embed.addFields({ name: 'Details', value: truncate(data.description, 300) });
      }
      return embed;
    }
    if (action === 'TaskUpdate') {
      const emoji = STATUS_EMOJI[data.status] || '📋';
      const parts: string[] = [];
      if (data.status) parts.push(`${emoji} **${data.status}**`);
      if (data.subject) parts.push(data.subject);
      return new EmbedBuilder()
        .setColor(data.status === 'completed' ? 0x2ecc71 : 0xf39c12)
        .setTitle(`Task #${data.taskId || '?'} Updated`)
        .setDescription(parts.join(' — ') || 'Updated');
    }
    return null;
  } catch {
    return null;
  }
}

export function renderTaskListEmbed(resultText: string): EmbedBuilder | null {
  if (!resultText.trim()) return null;
  let formatted = resultText;
  for (const [status, emoji] of Object.entries(STATUS_EMOJI)) {
    formatted = formatted.replaceAll(status, `${emoji} ${status}`);
  }
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('📋 Task Board')
    .setDescription(truncate(formatted, 4000));
}
