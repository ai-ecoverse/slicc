/**
 * Public SLICC transcript export contract.
 *
 * Renderer-neutral, platform-agnostic types for the v1 transcript bundle.
 * Consumed by every task that reads, writes, or validates a SLICC transcript.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const SLICC_TRANSCRIPT_FORMAT = 'slicc-transcript' as const;

// ---------------------------------------------------------------------------
// Union types
// ---------------------------------------------------------------------------

export type TranscriptCompletenessReason =
  | 'canonical-agent-history-unavailable'
  | 'tool-data-may-be-truncated'
  | 'model-metadata-unavailable'
  | 'scoop-history-unavailable'
  | 'attachment-file-missing'
  | 'attachment-association-unavailable'
  | 'complete-snapshot-unavailable';

export type TranscriptExportErrorCode =
  | 'permission-denied'
  | 'redaction-unavailable'
  | 'session-not-found'
  | 'transfer-aborted'
  | 'transfer-corrupt'
  | 'schema-invalid'
  | 'attachment-unreadable';

// ---------------------------------------------------------------------------
// Content block discriminated union
// ---------------------------------------------------------------------------

export type TranscriptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'attachment-ref'; attachmentId: string };

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool-result';
  timestamp: string;
  content: TranscriptContentBlock[];
  toolCallId?: string;
  isError?: boolean;
  source?: string;
  channel?: string;
  model?: { provider: string; id: string; api?: string };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  stopReason?: string;
  error?: string;
}

export interface TranscriptConversation {
  id: string;
  kind: 'cone' | 'scoop';
  name: string;
  folder?: string;
  parentConversationId?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: TranscriptMessage[];
}

export interface TranscriptDelegation {
  sourceConversationId: string;
  targetConversationId: string;
  toolCallId?: string;
  timestamp?: string;
}

export interface TranscriptAttachment {
  id: string;
  path: string;
  originalName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  sourceConversationId: string;
  sourceMessageId: string;
  handling: 'text-redacted' | 'binary-unchanged';
  present: boolean;
  missingReason?: 'attachment-file-missing';
}

export interface TranscriptRedaction {
  id: string;
  category: string;
  detector: 'known-secret' | 'credential-pattern' | 'pre-obfuscated';
  target:
    | { kind: 'json'; pointer: string }
    | { kind: 'attachment'; attachmentId: string };
}

export interface TranscriptExportProgress {
  phase:
    | 'waiting-for-conversations'
    | 'collecting'
    | 'redacting'
    | 'packaging'
    | 'transferring'
    | 'complete';
  processedBytes?: number;
  estimatedBytes?: number;
}

// ---------------------------------------------------------------------------
// Top-level document
// ---------------------------------------------------------------------------

export interface TranscriptDocumentV1 {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  export: {
    id: string;
    generatedAt: string;
    producer: { application: 'slicc'; version: string };
    format: typeof SLICC_TRANSCRIPT_FORMAT;
  };
  session: {
    id: string;
    title: string;
    state: 'active' | 'frozen';
    createdAt?: string;
    updatedAt?: string;
    frozenAt?: string;
    snapshotAt?: string;
    completeness: { status: 'complete' | 'partial'; missing: TranscriptCompletenessReason[] };
  };
  privacy: {
    reasoningExcluded: true;
    excludedReasoningBlocks: number;
    binaryAttachments: 'included-unchanged';
    redactionCounts: Record<string, number>;
    redactions: TranscriptRedaction[];
  };
  conversations: TranscriptConversation[];
  delegations: TranscriptDelegation[];
  attachments: TranscriptAttachment[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class TranscriptExportError extends Error {
  constructor(public readonly code: TranscriptExportErrorCode) {
    super(code);
    this.name = 'TranscriptExportError';
  }
}

// ---------------------------------------------------------------------------
// Validation result type
// ---------------------------------------------------------------------------

export type TranscriptValidationResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Validator helpers — never throw for untrusted input
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateContentBlock(
  block: unknown,
  path: string,
): TranscriptValidationResult {
  if (!isObj(block)) return { ok: false, error: `${path} must be a non-null object` };
  const t = block['type'];
  if (t !== 'text' && t !== 'tool-call' && t !== 'attachment-ref') {
    return {
      ok: false,
      error: `${path}.type must be "text", "tool-call", or "attachment-ref"`,
    };
  }
  return { ok: true };
}

function validateMessage(msg: unknown, path: string): TranscriptValidationResult {
  if (!isObj(msg)) return { ok: false, error: `${path} must be a non-null object` };

  const role = msg['role'];
  if (role !== 'user' && role !== 'assistant' && role !== 'tool-result') {
    return {
      ok: false,
      error: `${path}.role must be "user", "assistant", or "tool-result"`,
    };
  }

  if (typeof msg['id'] !== 'string') return { ok: false, error: `${path}.id must be a string` };
  if (typeof msg['sequence'] !== 'number') {
    return { ok: false, error: `${path}.sequence must be a number` };
  }
  if (typeof msg['timestamp'] !== 'string') {
    return { ok: false, error: `${path}.timestamp must be a string` };
  }

  const content = msg['content'];
  if (!Array.isArray(content)) return { ok: false, error: `${path}.content must be an array` };
  for (let i = 0; i < content.length; i++) {
    const result = validateContentBlock(content[i], `${path}.content[${i}]`);
    if (!result.ok) return result;
  }

  return { ok: true };
}

function validateConversation(conv: unknown, path: string): TranscriptValidationResult {
  if (!isObj(conv)) return { ok: false, error: `${path} must be a non-null object` };

  if (typeof conv['id'] !== 'string') return { ok: false, error: `${path}.id must be a string` };
  if (typeof conv['name'] !== 'string') {
    return { ok: false, error: `${path}.name must be a string` };
  }

  const kind = conv['kind'];
  if (kind !== 'cone' && kind !== 'scoop') {
    return { ok: false, error: `${path}.kind must be "cone" or "scoop"` };
  }

  const messages = conv['messages'];
  if (!Array.isArray(messages)) {
    return { ok: false, error: `${path}.messages must be an array` };
  }
  for (let i = 0; i < messages.length; i++) {
    const result = validateMessage(messages[i], `${path}.messages[${i}]`);
    if (!result.ok) return result;
  }

  return { ok: true };
}

function validateAttachment(att: unknown, path: string): TranscriptValidationResult {
  if (!isObj(att)) return { ok: false, error: `${path} must be a non-null object` };
  for (const field of ['id', 'path', 'originalName', 'mimeType', 'sha256']) {
    if (typeof att[field] !== 'string') {
      return { ok: false, error: `${path}.${field} must be a string` };
    }
  }
  for (const field of ['byteLength']) {
    if (typeof att[field] !== 'number') {
      return { ok: false, error: `${path}.${field} must be a number` };
    }
  }
  const handling = att['handling'];
  if (handling !== 'text-redacted' && handling !== 'binary-unchanged') {
    return { ok: false, error: `${path}.handling must be "text-redacted" or "binary-unchanged"` };
  }
  return { ok: true };
}

function validateRedaction(red: unknown, path: string): TranscriptValidationResult {
  if (!isObj(red)) return { ok: false, error: `${path} must be a non-null object` };
  if (typeof red['id'] !== 'string') return { ok: false, error: `${path}.id must be a string` };
  if (typeof red['category'] !== 'string') {
    return { ok: false, error: `${path}.category must be a string` };
  }
  const detector = red['detector'];
  if (
    detector !== 'known-secret' &&
    detector !== 'credential-pattern' &&
    detector !== 'pre-obfuscated'
  ) {
    return {
      ok: false,
      error: `${path}.detector must be "known-secret", "credential-pattern", or "pre-obfuscated"`,
    };
  }
  const target = red['target'];
  if (!isObj(target)) return { ok: false, error: `${path}.target must be a non-null object` };
  const kind = target['kind'];
  if (kind !== 'json' && kind !== 'attachment') {
    return { ok: false, error: `${path}.target.kind must be "json" or "attachment"` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

/**
 * Runtime validator for `TranscriptDocumentV1`.
 *
 * Checks all required discriminators, arrays, scalar types, and the invariant
 * `reasoningExcluded === true`. Never throws for untrusted input.
 */
export function validateTranscriptDocumentV1(value: unknown): TranscriptValidationResult {
  if (!isObj(value)) {
    return { ok: false, error: 'document must be a non-null object' };
  }

  // schemaVersion
  if (value['schemaVersion'] !== 1) {
    return { ok: false, error: 'schemaVersion must equal 1' };
  }

  // export
  const exp = value['export'];
  if (!isObj(exp)) return { ok: false, error: 'export must be a non-null object' };
  if (typeof exp['id'] !== 'string') return { ok: false, error: 'export.id must be a string' };
  if (typeof exp['generatedAt'] !== 'string') {
    return { ok: false, error: 'export.generatedAt must be a string' };
  }
  if (exp['format'] !== SLICC_TRANSCRIPT_FORMAT) {
    return { ok: false, error: 'export.format must equal "slicc-transcript"' };
  }
  const producer = exp['producer'];
  if (!isObj(producer)) {
    return { ok: false, error: 'export.producer must be a non-null object' };
  }
  if (producer['application'] !== 'slicc') {
    return { ok: false, error: 'export.producer.application must equal "slicc"' };
  }
  if (typeof producer['version'] !== 'string') {
    return { ok: false, error: 'export.producer.version must be a string' };
  }

  // session
  const session = value['session'];
  if (!isObj(session)) return { ok: false, error: 'session must be a non-null object' };
  if (typeof session['id'] !== 'string') {
    return { ok: false, error: 'session.id must be a string' };
  }
  if (typeof session['title'] !== 'string') {
    return { ok: false, error: 'session.title must be a string' };
  }
  const state = session['state'];
  if (state !== 'active' && state !== 'frozen') {
    return { ok: false, error: 'session.state must be "active" or "frozen"' };
  }
  const completeness = session['completeness'];
  if (!isObj(completeness)) {
    return { ok: false, error: 'session.completeness must be a non-null object' };
  }
  const compStatus = completeness['status'];
  if (compStatus !== 'complete' && compStatus !== 'partial') {
    return {
      ok: false,
      error: 'session.completeness.status must be "complete" or "partial"',
    };
  }
  if (!Array.isArray(completeness['missing'])) {
    return { ok: false, error: 'session.completeness.missing must be an array' };
  }

  // privacy
  const privacy = value['privacy'];
  if (!isObj(privacy)) return { ok: false, error: 'privacy must be a non-null object' };
  if (privacy['reasoningExcluded'] !== true) {
    return { ok: false, error: 'privacy.reasoningExcluded must be true' };
  }
  if (typeof privacy['excludedReasoningBlocks'] !== 'number') {
    return { ok: false, error: 'privacy.excludedReasoningBlocks must be a number' };
  }
  if (privacy['binaryAttachments'] !== 'included-unchanged') {
    return { ok: false, error: 'privacy.binaryAttachments must equal "included-unchanged"' };
  }
  if (!isObj(privacy['redactionCounts'])) {
    return { ok: false, error: 'privacy.redactionCounts must be a non-null object' };
  }
  const redactions = privacy['redactions'];
  if (!Array.isArray(redactions)) {
    return { ok: false, error: 'privacy.redactions must be an array' };
  }
  for (let i = 0; i < redactions.length; i++) {
    const result = validateRedaction(redactions[i], `privacy.redactions[${i}]`);
    if (!result.ok) return result;
  }

  // conversations
  const conversations = value['conversations'];
  if (!Array.isArray(conversations)) {
    return { ok: false, error: 'conversations must be an array' };
  }
  for (let i = 0; i < conversations.length; i++) {
    const result = validateConversation(conversations[i], `conversations[${i}]`);
    if (!result.ok) return result;
  }

  // delegations
  if (!Array.isArray(value['delegations'])) {
    return { ok: false, error: 'delegations must be an array' };
  }

  // attachments
  const attachments = value['attachments'];
  if (!Array.isArray(attachments)) {
    return { ok: false, error: 'attachments must be an array' };
  }
  for (let i = 0; i < attachments.length; i++) {
    const result = validateAttachment(attachments[i], `attachments[${i}]`);
    if (!result.ok) return result;
  }

  return { ok: true };
}
