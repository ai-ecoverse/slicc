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

/** Canonical runtime list of all valid completeness reasons. */
export const VALID_COMPLETENESS_REASONS: readonly TranscriptCompletenessReason[] = [
  'canonical-agent-history-unavailable',
  'tool-data-may-be-truncated',
  'model-metadata-unavailable',
  'scoop-history-unavailable',
  'attachment-file-missing',
  'attachment-association-unavailable',
  'complete-snapshot-unavailable',
] as const;

export type TranscriptExportErrorCode =
  | 'permission-denied'
  | 'redaction-unavailable'
  | 'session-not-found'
  | 'transfer-aborted'
  | 'transfer-corrupt'
  | 'schema-invalid'
  | 'attachment-unreadable';

/** Canonical set of all valid wire error codes — use for runtime validation. */
export const VALID_EXPORT_ERROR_CODES = new Set<TranscriptExportErrorCode>([
  'permission-denied',
  'redaction-unavailable',
  'session-not-found',
  'transfer-aborted',
  'transfer-corrupt',
  'schema-invalid',
  'attachment-unreadable',
]);

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
  target: { kind: 'json'; pointer: string } | { kind: 'attachment'; attachmentId: string };
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
// Private — scalar / regex constants
// ---------------------------------------------------------------------------

const VALID_COMPLETENESS_REASONS_SET = new Set<string>(VALID_COMPLETENESS_REASONS);
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Validator primitives — never throw for untrusted input
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSha256Hex(v: unknown): boolean {
  return typeof v === 'string' && SHA256_HEX_RE.test(v);
}

function isIsoDateTime(v: string): boolean {
  return ISO_DATETIME_RE.test(v) && Number.isFinite(Date.parse(v));
}

/** Build a human-readable "must be" enum error string. */
function enumError(label: string, allowed: readonly string[]): string {
  const quoted = allowed.map((v) => `"${v}"`);
  const last = quoted[quoted.length - 1] as string;
  if (quoted.length === 2) return `${label} must be ${quoted[0]} or ${last}`;
  return `${label} must be ${quoted.slice(0, -1).join(', ')}, or ${last}`;
}

/** Verify `value` is one of the allowed string literals. */
function validateEnum(
  value: unknown,
  allowed: readonly string[],
  label: string
): TranscriptValidationResult {
  if (typeof value !== 'string' || !(allowed as string[]).includes(value)) {
    return { ok: false, error: enumError(label, allowed) };
  }
  return { ok: true };
}

/** Validate every item in a pre-confirmed array. */
function validateArray(
  items: unknown[],
  validator: (item: unknown, path: string) => TranscriptValidationResult,
  basePath: string
): TranscriptValidationResult {
  for (let i = 0; i < items.length; i++) {
    const result = validator(items[i], `${basePath}[${i}]`);
    if (!result.ok) return result;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Content-block validators
// ---------------------------------------------------------------------------

function validateContentBlockFields(
  block: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const type = block['type'];
  if (type === 'text') {
    if (typeof block['text'] !== 'string') {
      return { ok: false, error: `${path}.text must be a string` };
    }
  } else if (type === 'tool-call') {
    if (typeof block['id'] !== 'string' || block['id'] === '') {
      return { ok: false, error: `${path}.id must be a non-empty string` };
    }
    if (typeof block['name'] !== 'string' || block['name'] === '') {
      return { ok: false, error: `${path}.name must be a non-empty string` };
    }
    if (!('input' in block)) {
      return { ok: false, error: `${path}.input must be present` };
    }
  } else {
    // attachment-ref
    if (typeof block['attachmentId'] !== 'string' || block['attachmentId'] === '') {
      return { ok: false, error: `${path}.attachmentId must be a non-empty string` };
    }
  }
  return { ok: true };
}

function validateContentBlock(block: unknown, path: string): TranscriptValidationResult {
  if (!isObj(block)) return { ok: false, error: `${path} must be a non-null object` };
  const typeResult = validateEnum(
    block['type'],
    ['text', 'tool-call', 'attachment-ref'],
    `${path}.type`
  );
  if (!typeResult.ok) return typeResult;
  return validateContentBlockFields(block, path);
}

// ---------------------------------------------------------------------------
// Message validators — usage helpers, role-specific checks, structural gate
// ---------------------------------------------------------------------------

function validateTokenFields(
  usage: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  for (const field of fields) {
    const v = usage[field];
    if (typeof v !== 'number') {
      return { ok: false, error: `${path}.${field} must be a number` };
    }
    if (!Number.isInteger(v) || v < 0) {
      return { ok: false, error: `${path}.${field} must be a non-negative integer` };
    }
  }
  return { ok: true };
}

function validateCostFields(
  cost: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
  for (const field of fields) {
    const v = cost[field];
    if (typeof v !== 'number') {
      return { ok: false, error: `${path}.${field} must be a number` };
    }
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, error: `${path}.${field} must be a finite non-negative number` };
    }
  }
  return { ok: true };
}

function validateUsage(usage: Record<string, unknown>, path: string): TranscriptValidationResult {
  const tokenResult = validateTokenFields(usage, path);
  if (!tokenResult.ok) return tokenResult;
  const cost = usage['cost'];
  if (!isObj(cost)) {
    return { ok: false, error: `${path}.cost must be a non-null object` };
  }
  return validateCostFields(cost, `${path}.cost`);
}

function validateMessageScalars(
  msg: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  if (typeof msg['id'] !== 'string') return { ok: false, error: `${path}.id must be a string` };
  if (typeof msg['sequence'] !== 'number') {
    return { ok: false, error: `${path}.sequence must be a number` };
  }
  const seq = msg['sequence'] as number;
  if (!Number.isInteger(seq) || seq < 1) {
    return { ok: false, error: `${path}.sequence must be a positive integer` };
  }
  if (typeof msg['timestamp'] !== 'string') {
    return { ok: false, error: `${path}.timestamp must be a string` };
  }
  if (!isIsoDateTime(msg['timestamp'] as string)) {
    return { ok: false, error: `${path}.timestamp must be a valid ISO 8601 date-time string` };
  }
  return { ok: true };
}

function validateToolResultMessage(
  msg: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const tcId = msg['toolCallId'];
  if (typeof tcId !== 'string' || tcId === '') {
    return {
      ok: false,
      error: `${path}.toolCallId must be a non-empty string for tool-result messages`,
    };
  }
  return { ok: true };
}

function validateMessageOptionalUsage(
  msg: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const usage = msg['usage'];
  if (usage === undefined) return { ok: true };
  if (!isObj(usage)) return { ok: false, error: `${path}.usage must be a non-null object` };
  return validateUsage(usage, `${path}.usage`);
}

function validateMessage(msg: unknown, path: string): TranscriptValidationResult {
  if (!isObj(msg)) return { ok: false, error: `${path} must be a non-null object` };
  const roleResult = validateEnum(
    msg['role'],
    ['user', 'assistant', 'tool-result'],
    `${path}.role`
  );
  if (!roleResult.ok) return roleResult;
  if (msg['role'] === 'tool-result') {
    const tcResult = validateToolResultMessage(msg, path);
    if (!tcResult.ok) return tcResult;
  }
  const scalarsResult = validateMessageScalars(msg, path);
  if (!scalarsResult.ok) return scalarsResult;
  const content = msg['content'];
  if (!Array.isArray(content)) return { ok: false, error: `${path}.content must be an array` };
  const contentResult = validateArray(content, validateContentBlock, `${path}.content`);
  if (!contentResult.ok) return contentResult;
  return validateMessageOptionalUsage(msg, path);
}

function validateConversation(conv: unknown, path: string): TranscriptValidationResult {
  if (!isObj(conv)) return { ok: false, error: `${path} must be a non-null object` };
  if (typeof conv['id'] !== 'string') return { ok: false, error: `${path}.id must be a string` };
  if (typeof conv['name'] !== 'string') {
    return { ok: false, error: `${path}.name must be a string` };
  }
  const kindResult = validateEnum(conv['kind'], ['cone', 'scoop'], `${path}.kind`);
  if (!kindResult.ok) return kindResult;
  const messages = conv['messages'];
  if (!Array.isArray(messages)) {
    return { ok: false, error: `${path}.messages must be an array` };
  }
  return validateArray(messages, validateMessage, `${path}.messages`);
}

// ---------------------------------------------------------------------------
// Attachment validators
// ---------------------------------------------------------------------------

function validateAttachmentStringFields(
  att: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  for (const field of [
    'id',
    'path',
    'originalName',
    'mimeType',
    'sha256',
    'sourceConversationId',
    'sourceMessageId',
  ] as const) {
    if (typeof att[field] !== 'string') {
      return { ok: false, error: `${path}.${field} must be a string` };
    }
  }
  return { ok: true };
}

function validatePresentAttachment(
  att: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const attPath = att['path'] as string;
  const sha256 = att['sha256'] as string;
  const byteLength = att['byteLength'] as number;
  if (attPath === '') return { ok: false, error: `${path}.path must be non-empty when present` };
  if (!isSha256Hex(sha256)) {
    return { ok: false, error: `${path}.sha256 must be a 64-char hex string when present` };
  }
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    return { ok: false, error: `${path}.byteLength must be a non-negative integer when present` };
  }
  if (att['missingReason'] !== undefined) {
    return { ok: false, error: `${path}.missingReason must be absent when present is true` };
  }
  return { ok: true };
}

function validateAbsentAttachment(
  att: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const attPath = att['path'] as string;
  const sha256 = att['sha256'] as string;
  const byteLength = att['byteLength'] as number;
  if (attPath !== '') return { ok: false, error: `${path}.path must be empty when not present` };
  if (sha256 !== '') return { ok: false, error: `${path}.sha256 must be empty when not present` };
  if (byteLength !== 0) {
    return { ok: false, error: `${path}.byteLength must be zero when not present` };
  }
  if (att['missingReason'] !== 'attachment-file-missing') {
    return {
      ok: false,
      error: `${path}.missingReason must equal "attachment-file-missing" when not present`,
    };
  }
  return { ok: true };
}

function validateAttachmentStateInvariants(
  att: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  return att['present']
    ? validatePresentAttachment(att, path)
    : validateAbsentAttachment(att, path);
}

function validateAttachment(att: unknown, path: string): TranscriptValidationResult {
  if (!isObj(att)) return { ok: false, error: `${path} must be a non-null object` };
  const strResult = validateAttachmentStringFields(att, path);
  if (!strResult.ok) return strResult;
  if (typeof att['byteLength'] !== 'number') {
    return { ok: false, error: `${path}.byteLength must be a number` };
  }
  if (typeof att['present'] !== 'boolean') {
    return { ok: false, error: `${path}.present must be a boolean` };
  }
  const handlingResult = validateEnum(
    att['handling'],
    ['text-redacted', 'binary-unchanged'],
    `${path}.handling`
  );
  if (!handlingResult.ok) return handlingResult;
  return validateAttachmentStateInvariants(att, path);
}

// ---------------------------------------------------------------------------
// Redaction validators
// ---------------------------------------------------------------------------

function validateRedactionTarget(
  target: Record<string, unknown>,
  path: string
): TranscriptValidationResult {
  const kindResult = validateEnum(target['kind'], ['json', 'attachment'], `${path}.kind`);
  if (!kindResult.ok) return kindResult;
  if (target['kind'] === 'json') {
    if (typeof target['pointer'] !== 'string') {
      return { ok: false, error: `${path}.pointer must be a string` };
    }
    const ptr = target['pointer'] as string;
    if (ptr !== '' && !ptr.startsWith('/')) {
      return { ok: false, error: `${path}.pointer must be a valid RFC 6901 JSON pointer` };
    }
  } else {
    // attachment kind
    if (typeof target['attachmentId'] !== 'string' || target['attachmentId'] === '') {
      return { ok: false, error: `${path}.attachmentId must be a non-empty string` };
    }
  }
  return { ok: true };
}

function validateRedaction(red: unknown, path: string): TranscriptValidationResult {
  if (!isObj(red)) return { ok: false, error: `${path} must be a non-null object` };
  if (typeof red['id'] !== 'string') return { ok: false, error: `${path}.id must be a string` };
  if (typeof red['category'] !== 'string') {
    return { ok: false, error: `${path}.category must be a string` };
  }
  const detectorResult = validateEnum(
    red['detector'],
    ['known-secret', 'credential-pattern', 'pre-obfuscated'],
    `${path}.detector`
  );
  if (!detectorResult.ok) return detectorResult;
  const target = red['target'];
  if (!isObj(target)) return { ok: false, error: `${path}.target must be a non-null object` };
  return validateRedactionTarget(target, `${path}.target`);
}

// ---------------------------------------------------------------------------
// Delegation validator
// ---------------------------------------------------------------------------

function validateDelegation(del: unknown, path: string): TranscriptValidationResult {
  if (!isObj(del)) return { ok: false, error: `${path} must be a non-null object` };
  if (typeof del['sourceConversationId'] !== 'string') {
    return { ok: false, error: `${path}.sourceConversationId must be a string` };
  }
  if (typeof del['targetConversationId'] !== 'string') {
    return { ok: false, error: `${path}.targetConversationId must be a string` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Completeness reason validator
// ---------------------------------------------------------------------------

function validateCompletenessReason(item: unknown, path: string): TranscriptValidationResult {
  if (typeof item !== 'string' || !VALID_COMPLETENESS_REASONS_SET.has(item)) {
    return { ok: false, error: `${path} is not a valid completeness reason` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Top-level section validators
// ---------------------------------------------------------------------------

function validateExport(exp: unknown): TranscriptValidationResult {
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
  return { ok: true };
}

function validateCompleteness(completeness: unknown): TranscriptValidationResult {
  if (!isObj(completeness)) {
    return { ok: false, error: 'session.completeness must be a non-null object' };
  }
  const statusResult = validateEnum(
    completeness['status'],
    ['complete', 'partial'],
    'session.completeness.status'
  );
  if (!statusResult.ok) return statusResult;
  if (!Array.isArray(completeness['missing'])) {
    return { ok: false, error: 'session.completeness.missing must be an array' };
  }
  return validateArray(
    completeness['missing'],
    validateCompletenessReason,
    'session.completeness.missing'
  );
}

function validateSession(session: unknown): TranscriptValidationResult {
  if (!isObj(session)) return { ok: false, error: 'session must be a non-null object' };
  if (typeof session['id'] !== 'string') {
    return { ok: false, error: 'session.id must be a string' };
  }
  if (typeof session['title'] !== 'string') {
    return { ok: false, error: 'session.title must be a string' };
  }
  const stateResult = validateEnum(session['state'], ['active', 'frozen'], 'session.state');
  if (!stateResult.ok) return stateResult;
  return validateCompleteness(session['completeness']);
}

function validatePrivacy(privacy: unknown): TranscriptValidationResult {
  if (!isObj(privacy)) return { ok: false, error: 'privacy must be a non-null object' };
  if (privacy['reasoningExcluded'] !== true) {
    return { ok: false, error: 'privacy.reasoningExcluded must be true' };
  }
  const erBlocks = privacy['excludedReasoningBlocks'];
  if (typeof erBlocks !== 'number') {
    return { ok: false, error: 'privacy.excludedReasoningBlocks must be a number' };
  }
  if (!Number.isInteger(erBlocks) || erBlocks < 0) {
    return { ok: false, error: 'privacy.excludedReasoningBlocks must be a non-negative integer' };
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
  return validateArray(redactions, validateRedaction, 'privacy.redactions');
}

function validateTopLevelArrays(doc: Record<string, unknown>): TranscriptValidationResult {
  const conversations = doc['conversations'];
  if (!Array.isArray(conversations)) {
    return { ok: false, error: 'conversations must be an array' };
  }
  const convsResult = validateArray(conversations, validateConversation, 'conversations');
  if (!convsResult.ok) return convsResult;
  const delegations = doc['delegations'];
  if (!Array.isArray(delegations)) {
    return { ok: false, error: 'delegations must be an array' };
  }
  const delsResult = validateArray(delegations, validateDelegation, 'delegations');
  if (!delsResult.ok) return delsResult;
  const attachments = doc['attachments'];
  if (!Array.isArray(attachments)) {
    return { ok: false, error: 'attachments must be an array' };
  }
  return validateArray(attachments, validateAttachment, 'attachments');
}

// ---------------------------------------------------------------------------
// Relational validation helpers — run only after structural checks pass
// ---------------------------------------------------------------------------

function checkUniqueConvAndMsgIds(conversations: unknown[]): TranscriptValidationResult {
  const convIds = new Set<string>();
  const msgIds = new Set<string>();
  for (const conv of conversations) {
    if (!isObj(conv) || typeof conv['id'] !== 'string') continue;
    if (convIds.has(conv['id'])) {
      return { ok: false, error: `duplicate conversation id "${conv['id']}"` };
    }
    convIds.add(conv['id']);
    const msgs = conv['messages'];
    if (!Array.isArray(msgs)) continue;
    for (const msg of msgs) {
      if (!isObj(msg) || typeof msg['id'] !== 'string') continue;
      if (msgIds.has(msg['id'])) {
        return { ok: false, error: `duplicate message id "${msg['id']}"` };
      }
      msgIds.add(msg['id']);
    }
  }
  return { ok: true };
}

function checkSequences(conversations: unknown[]): TranscriptValidationResult {
  for (const conv of conversations) {
    if (!isObj(conv)) continue;
    const msgs = conv['messages'];
    if (!Array.isArray(msgs)) continue;
    const convId = typeof conv['id'] === 'string' ? conv['id'] : '?';
    let prev = 0;
    for (const msg of msgs) {
      if (!isObj(msg) || typeof msg['sequence'] !== 'number') continue;
      const seq = msg['sequence'] as number;
      if (seq <= prev) {
        return {
          ok: false,
          error: `sequences in conversation "${convId}" must be strictly increasing`,
        };
      }
      prev = seq;
    }
  }
  return { ok: true };
}

/** Collect tool-call block ids from an array of raw messages. */
function getToolCallIdsFromMessages(msgs: unknown[]): string[] {
  const ids: string[] = [];
  for (const msg of msgs) {
    if (!isObj(msg)) continue;
    const content = msg['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isObj(block) && block['type'] === 'tool-call' && typeof block['id'] === 'string') {
        ids.push(block['id']);
      }
    }
  }
  return ids;
}

function collectAllToolCallIds(conversations: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const conv of conversations) {
    if (!isObj(conv)) continue;
    const msgs = conv['messages'];
    if (!Array.isArray(msgs)) continue;
    for (const id of getToolCallIdsFromMessages(msgs)) ids.add(id);
  }
  return ids;
}

function checkToolResultRefIds(
  conversations: unknown[],
  toolCallIds: Set<string>
): TranscriptValidationResult {
  for (const conv of conversations) {
    if (!isObj(conv)) continue;
    const msgs = conv['messages'];
    if (!Array.isArray(msgs)) continue;
    for (const msg of msgs) {
      if (!isObj(msg) || msg['role'] !== 'tool-result') continue;
      const tcId = msg['toolCallId'];
      if (typeof tcId !== 'string' || tcId === '') continue;
      if (!toolCallIds.has(tcId)) {
        return { ok: false, error: `tool-result message references unknown toolCallId "${tcId}"` };
      }
    }
  }
  return { ok: true };
}

function checkToolResultRefs(conversations: unknown[]): TranscriptValidationResult {
  return checkToolResultRefIds(conversations, collectAllToolCallIds(conversations));
}

function checkAttachmentRefsInContent(
  content: unknown[],
  attIds: Set<string>
): TranscriptValidationResult {
  for (const block of content) {
    if (!isObj(block) || block['type'] !== 'attachment-ref') continue;
    const attId = block['attachmentId'];
    if (typeof attId !== 'string' || !attIds.has(attId)) {
      return { ok: false, error: `attachment-ref references unknown attachmentId "${attId}"` };
    }
  }
  return { ok: true };
}

function checkAttachmentRefsInConversations(
  conversations: unknown[],
  attIds: Set<string>
): TranscriptValidationResult {
  for (const conv of conversations) {
    if (!isObj(conv)) continue;
    const msgs = conv['messages'];
    if (!Array.isArray(msgs)) continue;
    for (const msg of msgs) {
      if (!isObj(msg)) continue;
      const content = msg['content'];
      if (!Array.isArray(content)) continue;
      const r = checkAttachmentRefsInContent(content, attIds);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}

function checkAttachmentRefResolution(
  conversations: unknown[],
  attachments: unknown[]
): TranscriptValidationResult {
  const attIds = new Set<string>();
  for (const att of attachments) {
    if (isObj(att) && typeof att['id'] === 'string') attIds.add(att['id']);
  }
  return checkAttachmentRefsInConversations(conversations, attIds);
}

/** Build a map of conversationId → Set<messageId> from the conversations array. */
function buildConvMsgIndex(conversations: unknown[]): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const conv of conversations) {
    if (!isObj(conv) || typeof conv['id'] !== 'string') continue;
    const msgIds = new Set<string>();
    const msgs = conv['messages'];
    if (Array.isArray(msgs)) {
      for (const msg of msgs) {
        if (isObj(msg) && typeof msg['id'] === 'string') msgIds.add(msg['id']);
      }
    }
    idx.set(conv['id'], msgIds);
  }
  return idx;
}

function checkAttachmentSources(
  attachments: unknown[],
  conversations: unknown[]
): TranscriptValidationResult {
  const convMsgIdx = buildConvMsgIndex(conversations);
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!isObj(att)) continue;
    const convId = att['sourceConversationId'];
    const msgId = att['sourceMessageId'];
    if (typeof convId !== 'string' || typeof msgId !== 'string') continue;
    const msgIds = convMsgIdx.get(convId);
    if (!msgIds) {
      return {
        ok: false,
        error: `attachments[${i}].sourceConversationId "${convId}" does not exist`,
      };
    }
    if (!msgIds.has(msgId)) {
      return {
        ok: false,
        error: `attachments[${i}].sourceMessageId "${msgId}" does not exist in conversation "${convId}"`,
      };
    }
  }
  return { ok: true };
}

/** Build a map of conversationId → Set<toolCallId> from all tool-call blocks. */
function buildConvToolCallIndex(conversations: unknown[]): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const conv of conversations) {
    if (!isObj(conv) || typeof conv['id'] !== 'string') continue;
    const msgs = Array.isArray(conv['messages']) ? conv['messages'] : [];
    idx.set(conv['id'], new Set<string>(getToolCallIdsFromMessages(msgs)));
  }
  return idx;
}

function checkEachDelegation(
  delegations: unknown[],
  convIds: Set<string>,
  convToolCallIds: Map<string, Set<string>>
): TranscriptValidationResult {
  for (let i = 0; i < delegations.length; i++) {
    const del = delegations[i];
    if (!isObj(del)) continue;
    const srcId = del['sourceConversationId'];
    const tgtId = del['targetConversationId'];
    if (typeof srcId !== 'string' || !convIds.has(srcId)) {
      return {
        ok: false,
        error: `delegations[${i}].sourceConversationId "${srcId}" does not exist`,
      };
    }
    if (typeof tgtId !== 'string' || !convIds.has(tgtId)) {
      return {
        ok: false,
        error: `delegations[${i}].targetConversationId "${tgtId}" does not exist`,
      };
    }
    const tcId = del['toolCallId'];
    if (typeof tcId === 'string' && tcId !== '') {
      const srcToolCalls = convToolCallIds.get(srcId);
      if (!srcToolCalls?.has(tcId)) {
        return {
          ok: false,
          error: `delegations[${i}].toolCallId "${tcId}" does not exist in source conversation "${srcId}"`,
        };
      }
    }
  }
  return { ok: true };
}

function checkDelegationRefs(
  delegations: unknown[],
  conversations: unknown[]
): TranscriptValidationResult {
  const convIds = new Set<string>();
  for (const conv of conversations) {
    if (isObj(conv) && typeof conv['id'] === 'string') convIds.add(conv['id']);
  }
  return checkEachDelegation(delegations, convIds, buildConvToolCallIndex(conversations));
}

function checkRedactionTargetRef(
  target: Record<string, unknown>,
  attIds: Set<string>,
  path: string
): TranscriptValidationResult {
  if (target['kind'] !== 'attachment') return { ok: true };
  const attId = target['attachmentId'];
  if (typeof attId !== 'string' || !attIds.has(attId)) {
    return {
      ok: false,
      error: `${path}.attachmentId "${attId}" does not reference a known attachment`,
    };
  }
  return { ok: true };
}

function checkRedactionRefs(
  redactions: unknown[],
  attachments: unknown[]
): TranscriptValidationResult {
  const attIds = new Set<string>();
  for (const att of attachments) {
    if (isObj(att) && typeof att['id'] === 'string') attIds.add(att['id']);
  }
  for (let i = 0; i < redactions.length; i++) {
    const red = redactions[i];
    if (!isObj(red)) continue;
    const target = red['target'];
    if (!isObj(target)) continue;
    const r = checkRedactionTargetRef(target, attIds, `privacy.redactions[${i}].target`);
    if (!r.ok) return r;
  }
  return { ok: true };
}

function validateRelational(doc: Record<string, unknown>): TranscriptValidationResult {
  const conversations = doc['conversations'] as unknown[];
  const attachments = doc['attachments'] as unknown[];
  const delegations = doc['delegations'] as unknown[];
  const privacy = doc['privacy'] as Record<string, unknown> | undefined;
  const redactions = (
    Array.isArray(privacy?.['redactions']) ? privacy!['redactions'] : []
  ) as unknown[];

  const r1 = checkUniqueConvAndMsgIds(conversations);
  if (!r1.ok) return r1;
  const r2 = checkSequences(conversations);
  if (!r2.ok) return r2;
  const r3 = checkToolResultRefs(conversations);
  if (!r3.ok) return r3;
  const r4 = checkAttachmentRefResolution(conversations, attachments);
  if (!r4.ok) return r4;
  const r5 = checkAttachmentSources(attachments, conversations);
  if (!r5.ok) return r5;
  const r6 = checkDelegationRefs(delegations, conversations);
  if (!r6.ok) return r6;
  return checkRedactionRefs(redactions, attachments);
}

function validateStructuredBody(doc: Record<string, unknown>): TranscriptValidationResult {
  const r = validateTopLevelArrays(doc);
  if (!r.ok) return r;
  return validateRelational(doc);
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

/**
 * Runtime validator for `TranscriptDocumentV1`.
 *
 * Validates all required discriminators, type-specific content block fields,
 * scalar constraints (sequence ≥ 1, ISO timestamps, SHA-256 hex, attachment
 * state invariants), and relational cross-references. Returns early with the
 * first structural error before performing any relational checks.
 *
 * Never throws for untrusted input.
 */
export function validateTranscriptDocumentV1(value: unknown): TranscriptValidationResult {
  if (!isObj(value)) {
    return { ok: false, error: 'document must be a non-null object' };
  }
  if (value['schemaVersion'] !== 1) {
    return { ok: false, error: 'schemaVersion must equal 1' };
  }
  const exportResult = validateExport(value['export']);
  if (!exportResult.ok) return exportResult;
  const sessionResult = validateSession(value['session']);
  if (!sessionResult.ok) return sessionResult;
  const privacyResult = validatePrivacy(value['privacy']);
  if (!privacyResult.ok) return privacyResult;
  return validateStructuredBody(value);
}
