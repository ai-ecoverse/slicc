/**
 * Pure canonical message normalizer.
 *
 * Converts Pi AgentMessage[] to the public TranscriptMessage schema defined in
 * @slicc/shared-ts. No UI transcript caps, no agentMessagesToChatMessages().
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  TranscriptContentBlock,
  TranscriptConversation,
  TranscriptDelegation,
  TranscriptMessage,
} from '@slicc/shared-ts';

// ---------------------------------------------------------------------------
// Public input contract
// ---------------------------------------------------------------------------

export interface TranscriptConversationSource {
  id: string;
  kind: 'cone' | 'scoop';
  name: string;
  folder?: string;
  parentConversationId?: string;
  originToolCallId?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: readonly AgentMessage[];
}

// ---------------------------------------------------------------------------
// Public output contract
// ---------------------------------------------------------------------------

export interface CanonicalImageEntry {
  data: string;
  mimeType: string;
}

export interface NormalizedTranscript {
  conversations: TranscriptConversation[];
  delegations: TranscriptDelegation[];
  excludedReasoningBlocks: number;
  /** Base64 image data from assistant and tool-result Pi content blocks, keyed by attachmentId. */
  canonicalImages: Map<string, CanonicalImageEntry>;
}

// ---------------------------------------------------------------------------
// Internal type aliases
// ---------------------------------------------------------------------------

/** Widened user content type used for safe casting from Pi's narrower union. */
type UserContentRaw =
  | string
  | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

// ---------------------------------------------------------------------------
// Internal result shape for per-message normalizers
// ---------------------------------------------------------------------------

interface MessageNormalizeResult {
  message: TranscriptMessage | null;
  excludedReasoningBlocks: number;
  images: Map<string, CanonicalImageEntry>;
}

// ---------------------------------------------------------------------------
// Helper: message ID generator
// ---------------------------------------------------------------------------

function messageId(conversationId: string, sequence: number): string {
  return `${conversationId}-msg-${sequence.toString().padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Helper: image → attachment-ref
// ---------------------------------------------------------------------------

/** Deterministic attachment ID from message ID and in-message block index. */
function imageToAttachmentRef(
  messageId_: string,
  index: number
): { type: 'attachment-ref'; attachmentId: string } {
  return {
    type: 'attachment-ref',
    attachmentId: `${messageId_}-img-${index}`,
  };
}

// ---------------------------------------------------------------------------
// Content normalizers
// ---------------------------------------------------------------------------

/**
 * Normalizes user content (string or block array) to TranscriptContentBlock[].
 * Images become attachment-refs.
 */
function normalizeUserContent(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  msgId: string
): TranscriptContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  const blocks: TranscriptContentBlock[] = [];
  let imgIndex = 0;
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      blocks.push(imageToAttachmentRef(msgId, imgIndex++));
    }
    // Other unknown block types are silently skipped.
  }
  return blocks;
}

/**
 * Normalizes assistant content blocks, excluding thinking blocks.
 * Returns the normalized content, a count of excluded reasoning blocks,
 * and canonical image data keyed by attachmentId.
 */
function normalizeAssistantContent(
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    data?: string;
    mimeType?: string;
  }>,
  msgId: string
): {
  blocks: TranscriptContentBlock[];
  excluded: number;
  images: Map<string, CanonicalImageEntry>;
} {
  const blocks: TranscriptContentBlock[] = [];
  const images = new Map<string, CanonicalImageEntry>();
  let excluded = 0;
  let imgIndex = 0;
  for (const block of content) {
    if (block.type === 'thinking') {
      excluded += 1;
    } else if (block.type === 'text') {
      if (block.text) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'tool-call',
        id: block.id ?? '',
        name: block.name ?? '',
        input: block.arguments ?? {},
      });
    } else if (block.type === 'image') {
      const ref = imageToAttachmentRef(msgId, imgIndex++);
      blocks.push(ref);
      if (block.data && block.mimeType) {
        images.set(ref.attachmentId, { data: block.data, mimeType: block.mimeType });
      }
    }
  }
  return { blocks, excluded, images };
}

/**
 * Normalizes tool-result content blocks.
 * Images become attachment-refs with data captured in returned images map.
 */
function normalizeToolResultContent(
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  msgId: string
): { blocks: TranscriptContentBlock[]; images: Map<string, CanonicalImageEntry> } {
  const blocks: TranscriptContentBlock[] = [];
  const images = new Map<string, CanonicalImageEntry>();
  let imgIndex = 0;
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const ref = imageToAttachmentRef(msgId, imgIndex++);
      blocks.push(ref);
      if (block.data && block.mimeType) {
        images.set(ref.attachmentId, { data: block.data, mimeType: block.mimeType });
      }
    }
  }
  return { blocks, images };
}

// ---------------------------------------------------------------------------
// Per-role message normalizers
// ---------------------------------------------------------------------------

function normalizeUser(
  message: Extract<AgentMessage, { role: 'user' }>,
  conversationId: string,
  sequence: number
): MessageNormalizeResult {
  const id = messageId(conversationId, sequence);
  const content = normalizeUserContent(message.content as UserContentRaw, id);
  const normalized: TranscriptMessage = {
    id,
    sequence,
    role: 'user',
    timestamp: new Date(message.timestamp).toISOString(),
    content,
  };
  return { message: normalized, excludedReasoningBlocks: 0, images: new Map() };
}

function normalizeAssistant(
  message: Extract<AgentMessage, { role: 'assistant' }>,
  conversationId: string,
  sequence: number
): MessageNormalizeResult {
  const id = messageId(conversationId, sequence);
  const { blocks, excluded, images } = normalizeAssistantContent(
    message.content as Array<{
      type: string;
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      data?: string;
      mimeType?: string;
    }>,
    id
  );
  const normalized: TranscriptMessage = {
    id,
    sequence,
    role: 'assistant',
    timestamp: new Date(message.timestamp).toISOString(),
    content: blocks,
    model: { provider: message.provider, id: message.model, api: message.api },
    usage: message.usage,
    stopReason: message.stopReason,
    ...(message.errorMessage ? { error: message.errorMessage } : {}),
  };
  return { message: normalized, excludedReasoningBlocks: excluded, images };
}

function normalizeToolResult(
  message: Extract<AgentMessage, { role: 'toolResult' }>,
  conversationId: string,
  sequence: number
): MessageNormalizeResult {
  const id = messageId(conversationId, sequence);
  const { blocks: content, images } = normalizeToolResultContent(
    message.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
    id
  );
  const normalized: TranscriptMessage = {
    id,
    sequence,
    role: 'tool-result',
    timestamp: new Date(message.timestamp).toISOString(),
    content,
    toolCallId: message.toolCallId,
    isError: message.isError,
  };
  return { message: normalized, excludedReasoningBlocks: 0, images };
}

// ---------------------------------------------------------------------------
// Per-message dispatcher
// ---------------------------------------------------------------------------

function normalizeMessage(
  message: AgentMessage,
  conversationId: string,
  sequence: number
): MessageNormalizeResult {
  if (message.role === 'user') {
    return normalizeUser(message, conversationId, sequence);
  }
  if (message.role === 'assistant') {
    return normalizeAssistant(message, conversationId, sequence);
  }
  if (message.role === 'toolResult') {
    return normalizeToolResult(message, conversationId, sequence);
  }
  // Unknown roles (e.g. custom AgentMessages) are dropped.
  return { message: null, excludedReasoningBlocks: 0, images: new Map() };
}

// ---------------------------------------------------------------------------
// Delegation builder
// ---------------------------------------------------------------------------

function buildDelegations(
  sources: readonly TranscriptConversationSource[]
): TranscriptDelegation[] {
  const delegations: TranscriptDelegation[] = [];
  for (const source of sources) {
    if (!source.parentConversationId) continue;
    const delegation: TranscriptDelegation = {
      sourceConversationId: source.parentConversationId,
      targetConversationId: source.id,
    };
    if (source.originToolCallId) delegation.toolCallId = source.originToolCallId;
    delegations.push(delegation);
  }
  return delegations;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function normalizeConversations(
  sources: readonly TranscriptConversationSource[]
): NormalizedTranscript {
  let excludedReasoningBlocks = 0;
  const canonicalImages = new Map<string, CanonicalImageEntry>();
  const conversations = sources.map((source) => {
    const messages = source.messages.flatMap((message, index) => {
      const normalized = normalizeMessage(message, source.id, index + 1);
      excludedReasoningBlocks += normalized.excludedReasoningBlocks;
      for (const [id, entry] of normalized.images) canonicalImages.set(id, entry);
      return normalized.message ? [normalized.message] : [];
    });
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      ...(source.folder ? { folder: source.folder } : {}),
      ...(source.parentConversationId ? { parentConversationId: source.parentConversationId } : {}),
      ...(source.createdAt ? { createdAt: source.createdAt } : {}),
      ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
      messages,
    } satisfies TranscriptConversation;
  });
  return {
    conversations,
    delegations: buildDelegations(sources),
    excludedReasoningBlocks,
    canonicalImages,
  };
}
