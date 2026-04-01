import {
  ChannelType,
  EmbedBuilder,
  type Message,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import sharp from 'sharp';
import { config } from './config.ts';
import { getSessionByChannel } from './thread-manager.ts';
import { executeSessionPrompt } from './session-executor.ts';
import { isUserAllowed, isAbortError } from './utils.ts';
import type { ContentBlock, ImageBlock, ImageMediaType } from './providers/types.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

// Per-user rate limiting: userId:channelId → timestamp
const lastMessageTime = new Map<string, number>();

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.log',
  '.json',
  '.ts',
  '.js',
  '.py',
  '.sh',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.csv',
]);
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024; // 5MB

async function fetchAttachment(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function mimeToMediaType(ext: string): ImageMediaType {
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

async function buildImageBlock(data: Buffer, ext: string): Promise<ImageBlock> {
  let processed = data;

  if (data.length > MAX_IMAGE_BASE64_BYTES) {
    try {
      processed = await sharp(data)
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
    } catch {
      processed = data;
    }
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeToMediaType(ext),
      data: processed.toString('base64'),
    },
  };
}

export function resetMessageHandlerState(): void {
  lastMessageTime.clear();
}

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bots
  if (message.author.bot) return;

  const channel = message.channel;

  // Only handle messages in:
  //   - GuildText channels (persistent sessions — Category > Channel > messages)
  //   - Threads (subagent sessions — Category > Channel > Thread > messages)
  const isSessionChannel = channel.type === ChannelType.GuildText;
  const isSubagentThread = channel.isThread();

  if (!isSessionChannel && !isSubagentThread) return;

  // Look up session by the channel/thread ID (both persistent and subagent sessions use this key)
  const session = getSessionByChannel(channel.id);
  if (!session) return;

  // Authorization
  if (!isUserAllowed(message.author.id, config.allowedUsers, config.allowAllUsers)) {
    await (channel as SessionChannel)
      .send('You are not authorized to use this bot.')
      .catch(() => {});
    return;
  }

  // Per-user+channel rate limiting
  const rateKey = `${message.author.id}:${channel.id}`;
  const now = Date.now();
  const last = lastMessageTime.get(rateKey) || 0;
  if (now - last < config.rateLimitMs) {
    return; // silently drop
  }
  lastMessageTime.set(rateKey, now);

  // Guard: already generating
  if (session.isGenerating) {
    await (channel as SessionChannel)
      .send('*Agent is already generating. Stop it first with `/agent stop`.*')
      .catch(() => {});
    return;
  }

  // Build content blocks from message text + attachments
  const blocks: ContentBlock[] = [];

  if (message.content.trim()) {
    blocks.push({ type: 'text', text: message.content.trim() });
  }

  for (const attachment of message.attachments.values()) {
    const ext = getExtension(attachment.name || '');

    if (IMAGE_EXTS.has(ext)) {
      try {
        const data = await fetchAttachment(attachment.url);
        const imageBlock = await buildImageBlock(data, ext);
        blocks.push(imageBlock);
      } catch {
        // Skip attachment on error
      }
    } else if (TEXT_EXTS.has(ext) && attachment.size < 100_000) {
      try {
        const data = await fetchAttachment(attachment.url);
        blocks.push({ type: 'text', text: `[${attachment.name}]\n${data.toString('utf-8')}` });
      } catch {
        // Skip
      }
    }
  }

  if (blocks.length === 0) return;

  // Immediate feedback: react to user message to show bot is alive
  try {
    await message.react('👀');
  } catch {
    // Ignore reaction errors (missing permissions, etc.)
  }

  await executeSessionPrompt(
    session,
    channel as SessionChannel,
    blocks.length === 1 && blocks[0].type === 'text'
      ? (blocks[0] as { type: 'text'; text: string }).text
      : blocks,
  );

  // After a subagent finishes, notify the parent session channel
  if (session.type === 'subagent' && session.parentChannelId && message.guild) {
    const parentChannel = message.guild.channels.cache.get(session.parentChannelId) as
      | TextChannel
      | undefined;
    if (parentChannel?.isTextBased() && !parentChannel.isThread()) {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`✅ Subagent Finished: ${session.agentLabel}`)
        .setDescription(
          `<#${session.channelId}> has completed a pass. Review the thread for output.`,
        );
      await parentChannel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}
