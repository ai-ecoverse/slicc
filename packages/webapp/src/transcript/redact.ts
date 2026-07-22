/**
 * Immutable JSON walker and transcript redaction orchestrator.
 *
 * Orchestrates:
 *   1. Recursive string-leaf collection with RFC 6901 pointers.
 *   2. 1 MiB-capped batching through a KnownSecretBatchRedactor.
 *   3. Deterministic credential-pattern scanning (redactCredentialPatterns).
 *   4. Immutable spine reconstruction (only changed nodes are new objects).
 *   5. TranscriptRedaction records and redactionCounts population.
 */
import {
  TranscriptExportError,
  redactCredentialPatterns,
  type TranscriptDocumentV1,
  type TranscriptRedaction,
} from '@slicc/shared-ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface KnownSecretBatchRedactor {
  redact(texts: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
}

export interface RedactedTranscriptResult {
  document: TranscriptDocumentV1;
  textAttachments: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum UTF-16 code units per knownSecrets batch (≈ 1 MiB for ASCII). */
const BATCH_MAX_CHARS = 1 * 1024 * 1024;
const ID_PREFIX = 'r';

// ---------------------------------------------------------------------------
// JSON tree walker
// ---------------------------------------------------------------------------

interface StringLeaf {
  readonly pointer: string;
  readonly value: string;
}

function pointerEscape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function collectLeaves(value: unknown, pointer: string, out: StringLeaf[]): void {
  if (typeof value === 'string') {
    out.push({ pointer, value });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectLeaves(value[i], `${pointer}/${i}`, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectLeaves(v, `${pointer}/${pointerEscape(k)}`, out);
    }
  }
}

function applyLeaves(
  value: unknown,
  pointer: string,
  updates: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') return updates.get(pointer) ?? value;
  if (Array.isArray(value)) {
    let changed = false;
    const arr: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const v2 = applyLeaves(value[i], `${pointer}/${i}`, updates);
      if (v2 !== value[i]) changed = true;
      arr.push(v2);
    }
    return changed ? arr : value;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const v2 = applyLeaves(v, `${pointer}/${pointerEscape(k)}`, updates);
      if (v2 !== v) changed = true;
      obj[k] = v2;
    }
    return changed ? obj : value;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

interface MarkerEntry {
  readonly category: string;
  readonly id: string;
  count: number;
}

/**
 * Returns a multiset (Map keyed by full marker text) of all ⟦REDACTED:⟧
 * markers in `text`. Using the full marker text as key means two markers with
 * the same id but different categories are tracked separately.
 */
function markerMultiset(text: string): Map<string, MarkerEntry> {
  const entries = new Map<string, MarkerEntry>();
  for (const m of text.matchAll(/⟦REDACTED:([^:⟧]+):([^⟧]+)⟧/g)) {
    const key = m[0]!;
    const existing = entries.get(key);
    if (existing) {
      existing.count++;
    } else {
      entries.set(key, { category: m[1]!, id: m[2]!, count: 1 });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------

async function runBatches(
  texts: string[],
  knownSecrets: KnownSecretBatchRedactor,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const out: string[] = [];
  let start = 0;
  while (start < texts.length) {
    if (signal?.aborted) throw new TranscriptExportError('redaction-unavailable');
    let chars = 0;
    let end = start;
    while (end < texts.length) {
      const len = texts[end]!.length;
      if (end > start && chars + len > BATCH_MAX_CHARS) break;
      chars += len;
      end++;
    }
    const batch = texts.slice(start, end);
    let result: readonly string[];
    try {
      result = await knownSecrets.redact(batch, signal);
    } catch {
      throw new TranscriptExportError('redaction-unavailable');
    }
    if (result.length !== batch.length) throw new TranscriptExportError('redaction-unavailable');
    out.push(...result);
    start = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-leaf processor
// ---------------------------------------------------------------------------

interface LeafOutcome {
  readonly finalText: string;
  readonly redactions: TranscriptRedaction[];
  readonly nextId: number;
}

function processLeaf(
  original: string,
  afterKnown: string,
  target: TranscriptRedaction['target'],
  nextId: number,
): LeafOutcome {
  const redactions: TranscriptRedaction[] = [];

  // Pre-obfuscated: markers that existed BEFORE we called knownSecrets.
  // One record per distinct marker text — the same marker appearing N times in
  // one string produces exactly one record (avoids inflated redactionCounts).
  const preCounts = markerMultiset(original);
  for (const { category, id } of preCounts.values()) {
    redactions.push({ id, category, detector: 'pre-obfuscated', target });
  }

  // Known-secret: markers whose occurrence count increased after knownSecrets.redact().
  // Multiset comparison prevents the Set-based collision where a marker already
  // present in `original` shadows a newly introduced occurrence of the same marker.
  const afterCounts = markerMultiset(afterKnown);
  for (const [marker, { category, id, count: afterCount }] of afterCounts) {
    const preCount = preCounts.get(marker)?.count ?? 0;
    if (afterCount > preCount) {
      redactions.push({ id, category, detector: 'known-secret', target });
    }
  }

  // Credential patterns applied on top of the known-secret-replaced text
  const { text: finalText, matches, nextId: n } = redactCredentialPatterns(
    afterKnown,
    ID_PREFIX,
    nextId,
  );
  for (const { id, category } of matches) {
    redactions.push({ id, category, detector: 'credential-pattern', target });
  }

  return { finalText, redactions, nextId: n };
}

// ---------------------------------------------------------------------------
// Redaction accumulator
// ---------------------------------------------------------------------------

function accumulate(
  outcomes: LeafOutcome[],
  redactions: TranscriptRedaction[],
  counts: Record<string, number>,
): void {
  for (const { redactions: rs } of outcomes) {
    for (const r of rs) {
      redactions.push(r);
      counts[r.category] = (counts[r.category] ?? 0) + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Redact all string content in `document` and `textAttachments`.
 *
 * Throws `TranscriptExportError('redaction-unavailable')` on batch failure,
 * length mismatch, or abort.
 */
export async function redactTranscript(
  document: TranscriptDocumentV1,
  textAttachments: ReadonlyMap<string, string>,
  knownSecrets: KnownSecretBatchRedactor,
  signal?: AbortSignal,
): Promise<RedactedTranscriptResult> {
  if (signal?.aborted) throw new TranscriptExportError('redaction-unavailable');

  // Collect all string leaves from the document tree, skipping the privacy
  // subtree. Privacy metadata (redaction ids, pointers) is not secret and is
  // overridden unconditionally at the end, so sending it to knownSecrets wastes
  // quota/bandwidth without any correctness benefit.
  const { privacy: _privacy, ...docWithoutPrivacy } = document;
  const docLeaves: StringLeaf[] = [];
  collectLeaves(docWithoutPrivacy, '', docLeaves);

  // Collect attachment strings in stable order
  const attEntries = [...textAttachments.entries()];

  // Send everything through knownSecrets in 1 MiB batches
  const allTexts = [...docLeaves.map((l) => l.value), ...attEntries.map(([, v]) => v)];
  const afterKnown = await runBatches(allTexts, knownSecrets, signal);

  const allRedactions: TranscriptRedaction[] = [];
  const redactionCounts: Record<string, number> = {};
  let nextId = 1;

  // Process document leaves
  const docUpdates = new Map<string, string>();
  const docOutcomes: LeafOutcome[] = [];
  for (let i = 0; i < docLeaves.length; i++) {
    const leaf = docLeaves[i]!;
    const outcome = processLeaf(
      leaf.value, afterKnown[i]!, { kind: 'json', pointer: leaf.pointer }, nextId,
    );
    nextId = outcome.nextId;
    if (outcome.finalText !== leaf.value) docUpdates.set(leaf.pointer, outcome.finalText);
    docOutcomes.push(outcome);
  }
  accumulate(docOutcomes, allRedactions, redactionCounts);

  // Process attachments
  const newAttachments = new Map<string, string>();
  const attOffset = docLeaves.length;
  const attOutcomes: LeafOutcome[] = [];
  for (let i = 0; i < attEntries.length; i++) {
    const [attId, original] = attEntries[i]!;
    const outcome = processLeaf(
      original,
      afterKnown[attOffset + i]!,
      { kind: 'attachment', attachmentId: attId },
      nextId,
    );
    nextId = outcome.nextId;
    newAttachments.set(attId, outcome.finalText);
    attOutcomes.push(outcome);
  }
  accumulate(attOutcomes, allRedactions, redactionCounts);

  // Rebuild document with immutable spine replacement, then override privacy metadata
  const rebuilt = applyLeaves(document, '', docUpdates) as TranscriptDocumentV1;
  const finalDoc: TranscriptDocumentV1 = {
    ...rebuilt,
    privacy: { ...rebuilt.privacy, redactionCounts, redactions: allRedactions },
  };

  return { document: finalDoc, textAttachments: newAttachments };
}
