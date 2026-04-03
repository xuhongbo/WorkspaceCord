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
const MAX_TOTAL_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = (() => {
  const env = Number(process.env.WORKSPACECORD_ATTACHMENT_FETCH_TIMEOUT_MS ?? '');
  if (Number.isFinite(env) && env > 0) {
    return env;
  }
  return 15_000;
})();
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

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
  if (!options.currentSessionId) {
    throw new Error('currentSessionId is required: session context must be provided for attachment downloads');
  }
  if (options.currentSessionId !== options.sessionId) {
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

  if (records.some((record) => !record.url)) {
    throw new Error('Missing download URL for one or more attachments');
  }
  if (options.all) {
    const totalBytes = records.reduce((sum, record) => sum + record.sizeBytes, 0);
    if (totalBytes > MAX_TOTAL_DOWNLOAD_BYTES) {
      throw new Error('Total attachment size exceeds --all limit');
    }
  }

  const inboxDir = join(getDataDir(), 'inbox', options.sessionId);
  await mkdir(inboxDir, { recursive: true });

  const downloaded: DownloadedAttachment[] = [];
  for (const record of records) {
    assertHttpUrl(record.url);
    if (record.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds 25MB limit: ${record.name}`);
    }
    const response = await fetchWithTimeout(record.url, record);
    if (!response.ok) {
      throw new Error(`Failed to download attachment: ${record.name}`);
    }
    const bytes = Buffer.from(await readArrayBufferWithTimeout(response, record));
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

function assertHttpUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid attachment URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Attachment URL must use http or https: ${rawUrl}`);
  }
}

async function readArrayBufferWithTimeout(
  response: Response,
  record: AttachmentRecord,
): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Attachment download timed out: ${record.name}`));
    }, FETCH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([readResponseBody(response, record), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(url: string, record: AttachmentRecord): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Attachment download timed out: ${record.name}`));
    }, FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetch(url, { signal: controller.signal }), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseBody(
  response: Response,
  record: AttachmentRecord,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds 25MB limit: ${record.name}`);
    }
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      await reader.cancel('attachment too large');
      throw new Error(`Attachment exceeds 25MB limit: ${record.name}`);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}
