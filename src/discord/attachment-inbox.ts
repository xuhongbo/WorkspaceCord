import { basename, extname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Store, getDataDir } from '../persistence.ts';

export type AttachmentSummary = {
  attachmentId: string;
  name: string;
  contentType: string | null;
  sizeBytes: number;
};

export type AttachmentRecord = AttachmentSummary & {
  url: string;
};

export type DownloadedAttachment = AttachmentSummary & {
  path: string;
};

type RawAttachment = {
  id?: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  url?: string;
};

type AttachmentIndex = Record<string, AttachmentRecord[]>;

type FetchAttachmentOptions = {
  sessionId: string;
  messageId: string;
  attachmentId?: string;
  all?: boolean;
  currentSessionId?: string;
};

type AttachmentDownloadAuditEntry = {
  sessionId: string;
  messageId: string;
  attachmentId?: string;
  all: boolean;
  downloadedPaths: string[];
  timestampIso: string;
};

const attachmentStore = new Store<AttachmentIndex>('attachment-inbox.json');
const attachmentAuditStore = new Store<AttachmentDownloadAuditEntry[]>('attachment-download-audit.json');
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function makeKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

function normalizeAttachment(
  attachment: RawAttachment,
  messageId: string,
  index: number,
): AttachmentRecord {
  return {
    attachmentId: attachment.id ?? `${messageId}-${index}`,
    name: attachment.name ?? `attachment-${index + 1}`,
    contentType: attachment.contentType ?? null,
    sizeBytes: attachment.size ?? 0,
    url: attachment.url ?? '',
  };
}

function sanitizeFilename(name: string, attachmentId: string): string {
  const safeBase = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  const ext = extname(safeBase);
  const stem = safeBase.slice(0, ext ? -ext.length : undefined) || attachmentId;
  const normalizedExt = ext.replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
  return `${stem}-${attachmentId}${normalizedExt}`;
}

async function readIndex(): Promise<AttachmentIndex> {
  return (await attachmentStore.read()) ?? {};
}

async function writeIndex(index: AttachmentIndex): Promise<void> {
  await attachmentStore.write(index);
}

async function appendAudit(entry: AttachmentDownloadAuditEntry): Promise<void> {
  const existing = (await attachmentAuditStore.read()) ?? [];
  existing.push(entry);
  await attachmentAuditStore.write(existing);
}

export async function resetAttachmentInboxState(): Promise<void> {
  await writeIndex({});
}

export async function registerMessageAttachments(
  sessionId: string,
  messageId: string,
  attachments: RawAttachment[],
): Promise<AttachmentRecord[]> {
  const index = await readIndex();
  const records = attachments.map((attachment, idx) => normalizeAttachment(attachment, messageId, idx));
  index[makeKey(sessionId, messageId)] = records;
  await writeIndex(index);
  return records;
}

export async function getMessageAttachments(
  sessionId: string,
  messageId: string,
  attachmentId?: string,
): Promise<AttachmentRecord[]> {
  const index = await readIndex();
  const records = index[makeKey(sessionId, messageId)] ?? [];
  if (!attachmentId) return records;
  return records.filter((record) => record.attachmentId === attachmentId);
}

export async function fetchRegisteredAttachments(
  options: FetchAttachmentOptions,
): Promise<DownloadedAttachment[]> {
  if (options.currentSessionId && options.currentSessionId !== options.sessionId) {
    throw new Error('current session mismatch: cross-session attachment download is not allowed');
  }

  const records = await getMessageAttachments(
    options.sessionId,
    options.messageId,
    options.all ? undefined : options.attachmentId,
  );

  if (!options.all && !options.attachmentId) {
    throw new Error('attachmentId is required unless --all is set');
  }
  if (records.length === 0) {
    throw new Error('No registered attachments found for the requested message');
  }

  const inboxDir = join(getDataDir(), 'inbox', options.sessionId);
  await mkdir(inboxDir, { recursive: true });

  const downloaded: DownloadedAttachment[] = [];
  for (const record of records) {
    if (record.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds 25MB limit: ${record.name}`);
    }
    const response = await fetch(record.url);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${record.name}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const filename = sanitizeFilename(record.name, record.attachmentId);
    const path = join(inboxDir, filename);
    await writeFile(path, bytes);
    downloaded.push({
      attachmentId: record.attachmentId,
      name: record.name,
      contentType: record.contentType,
      sizeBytes: record.sizeBytes,
      path,
    });
  }

  await appendAudit({
    sessionId: options.sessionId,
    messageId: options.messageId,
    attachmentId: options.attachmentId,
    all: options.all === true,
    downloadedPaths: downloaded.map((item) => item.path),
    timestampIso: new Date().toISOString(),
  });

  return downloaded;
}
