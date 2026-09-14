import {
  isStructuralTranscriptPointer,
  redactCredentialPatterns,
  type TranscriptDocumentV1,
  TranscriptExportError,
  type TranscriptRedaction,
} from '@slicc/shared-ts';

export interface KnownSecretBatchRedactor {
  redact(texts: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
}

export interface RedactedTranscriptResult {
  document: TranscriptDocumentV1;
  textAttachments: Map<string, string>;
}

const BATCH_MAX_CHARS = 1 * 1024 * 1024;
const ID_PREFIX = 'r';

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

interface StringLeaf {
  readonly pointer: string;
  readonly value: string;
}

function pointerEscape(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (isJsonObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      collectLeaves(v, `${pointer}/${pointerEscape(k)}`, out);
    }
  }
}

function applyJsonLeaves(
  value: JsonValue,
  pointer: string,
  updates: ReadonlyMap<string, string>
): JsonValue {
  if (typeof value === 'string') return updates.get(pointer) ?? value;
  if (Array.isArray(value)) {
    let changed = false;
    const arr: JsonValue[] = [];
    for (let i = 0; i < value.length; i++) {
      const v2 = applyJsonLeaves(value[i], `${pointer}/${i}`, updates);
      if (v2 !== value[i]) changed = true;
      arr.push(v2);
    }
    return changed ? arr : value;
  }
  if (isJsonObject(value)) {
    let changed = false;
    const obj: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const v2 = applyJsonLeaves(v, `${pointer}/${pointerEscape(k)}`, updates);
      if (v2 !== v) changed = true;
      obj[k] = v2;
    }
    return changed ? obj : value;
  }
  return value;
}

function applyLeaves(
  value: unknown,
  pointer: string,
  updates: ReadonlyMap<string, string>
): unknown {
  if (isJsonObject(value)) return applyJsonLeaves(value, pointer, updates);
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
  return value;
}

interface MarkerEntry {
  readonly category: string;
  readonly id: string;
  count: number;
}

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

async function runBatches(
  texts: string[],
  knownSecrets: KnownSecretBatchRedactor,
  signal: AbortSignal | undefined
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

interface LeafOutcome {
  readonly finalText: string;
  readonly redactions: TranscriptRedaction[];
  readonly nextId: number;
}

function processLeaf(
  original: string,
  afterKnown: string,
  target: TranscriptRedaction['target'],
  nextId: number
): LeafOutcome {
  const redactions: TranscriptRedaction[] = [];

  const preCounts = markerMultiset(original);
  for (const { category, id } of preCounts.values()) {
    redactions.push({ id, category, detector: 'pre-obfuscated', target });
  }

  const afterCounts = markerMultiset(afterKnown);
  for (const [marker, { category, id, count: afterCount }] of afterCounts) {
    const preCount = preCounts.get(marker)?.count ?? 0;
    if (afterCount > preCount) {
      redactions.push({ id, category, detector: 'known-secret', target });
    }
  }

  const {
    text: finalText,
    matches,
    nextId: n,
  } = redactCredentialPatterns(afterKnown, ID_PREFIX, nextId);
  for (const { id, category } of matches) {
    redactions.push({ id, category, detector: 'credential-pattern', target });
  }

  return { finalText, redactions, nextId: n };
}

function accumulate(
  outcomes: LeafOutcome[],
  redactions: TranscriptRedaction[],
  counts: Record<string, number>
): void {
  for (const { redactions: rs } of outcomes) {
    for (const r of rs) {
      redactions.push(r);
      counts[r.category] = (counts[r.category] ?? 0) + 1;
    }
  }
}

export async function redactTranscript(
  document: TranscriptDocumentV1,
  textAttachments: ReadonlyMap<string, string>,
  knownSecrets: KnownSecretBatchRedactor,
  signal?: AbortSignal
): Promise<RedactedTranscriptResult> {
  if (signal?.aborted) throw new TranscriptExportError('redaction-unavailable');

  const { privacy: _privacy, ...docWithoutPrivacy } = document;
  const allDocLeaves: StringLeaf[] = [];
  collectLeaves(docWithoutPrivacy, '', allDocLeaves);

  const docLeaves = allDocLeaves.filter((leaf) => !isStructuralTranscriptPointer(leaf.pointer));

  const attEntries = [...textAttachments.entries()];

  const allTexts = [...docLeaves.map((l) => l.value), ...attEntries.map(([, v]) => v)];
  const afterKnown = await runBatches(allTexts, knownSecrets, signal);

  const allRedactions: TranscriptRedaction[] = [];
  const redactionCounts: Record<string, number> = {};
  let nextId = 1;

  const docUpdates = new Map<string, string>();
  const docOutcomes: LeafOutcome[] = [];
  for (let i = 0; i < docLeaves.length; i++) {
    const leaf = docLeaves[i]!;
    const outcome = processLeaf(
      leaf.value,
      afterKnown[i]!,
      { kind: 'json', pointer: leaf.pointer },
      nextId
    );
    nextId = outcome.nextId;
    if (outcome.finalText !== leaf.value) docUpdates.set(leaf.pointer, outcome.finalText);
    docOutcomes.push(outcome);
  }
  accumulate(docOutcomes, allRedactions, redactionCounts);

  const newAttachments = new Map<string, string>();
  const attOffset = docLeaves.length;
  const attOutcomes: LeafOutcome[] = [];
  for (let i = 0; i < attEntries.length; i++) {
    const [attId, original] = attEntries[i]!;
    const outcome = processLeaf(
      original,
      afterKnown[attOffset + i]!,
      { kind: 'attachment', attachmentId: attId },
      nextId
    );
    nextId = outcome.nextId;
    newAttachments.set(attId, outcome.finalText);
    attOutcomes.push(outcome);
  }
  accumulate(attOutcomes, allRedactions, redactionCounts);

  const rebuilt = applyLeaves(document, '', docUpdates) as TranscriptDocumentV1;
  const finalDoc: TranscriptDocumentV1 = {
    ...rebuilt,
    privacy: { ...rebuilt.privacy, redactionCounts, redactions: allRedactions },
  };

  return { document: finalDoc, textAttachments: newAttachments };
}
