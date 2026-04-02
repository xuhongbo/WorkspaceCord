export type ChunkMode = 'length' | 'newline';
export type ReplyToMode = 'off' | 'first' | 'all';
export type DeliveryMode =
  | 'user_reply'
  | 'system_notice'
  | 'summary'
  | 'log'
  | 'progress_update';

export type DeliveryPolicyConfig = {
  textChunkLimit: number;
  chunkMode: ChunkMode;
  replyToMode: ReplyToMode;
  ackReaction: string;
};

export type DeliveryPlan = {
  sessionId: string;
  chatId: string;
  replyToMessageId?: string;
  replyToMode: ReplyToMode;
  editTargetMessageId?: string;
  chunks: string[];
  filesOnFirstChunk: string[];
  mode: DeliveryMode;
};

export type BuildDeliveryPlanInput = {
  sessionId: string;
  chatId: string;
  text: string;
  files: string[];
  mode: DeliveryMode;
  replyToMessageId?: string;
  editTargetMessageId?: string;
  policy: DeliveryPolicyConfig;
};

const MAX_CHUNK_LIMIT = 2000;
const MAX_ATTACHMENTS = 10;

export function clampChunkLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_CHUNK_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit), MAX_CHUNK_LIMIT));
}

export function chunkText(text: string, limit: number, mode: ChunkMode): string[] {
  const safeLimit = clampChunkLimit(limit);
  if (text.length <= safeLimit) return [text];

  const out: string[] = [];
  let rest = text;
  while (rest.length > safeLimit) {
    let cut = safeLimit;
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', safeLimit);
      const line = rest.lastIndexOf('\n', safeLimit);
      const space = rest.lastIndexOf(' ', safeLimit);
      cut = para > safeLimit / 2 ? para : line > safeLimit / 2 ? line : space > 0 ? space : safeLimit;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export function buildDeliveryPlan(input: BuildDeliveryPlanInput): DeliveryPlan {
  const chunks = chunkText(input.text, input.policy.textChunkLimit, input.policy.chunkMode);
  const filesOnFirstChunk = input.files.slice(0, MAX_ATTACHMENTS);
  const replyToMode = input.policy.replyToMode;
  const replyToMessageId =
    input.mode === 'system_notice' || input.mode === 'summary'
      ? undefined
      : replyToMode === 'off'
        ? undefined
        : input.replyToMessageId;

  return {
    sessionId: input.sessionId,
    chatId: input.chatId,
    replyToMessageId,
    replyToMode,
    editTargetMessageId: input.editTargetMessageId,
    chunks,
    filesOnFirstChunk,
    mode: input.mode,
  };
}
