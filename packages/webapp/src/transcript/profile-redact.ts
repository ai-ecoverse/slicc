import { redactCredentialPatterns, TranscriptExportError } from '@slicc/shared-ts';
import { AT_REST_CREDENTIAL_CATEGORIES } from './archive-redaction.js';
import type { KnownSecretBatchRedactor } from './redact.js';

export const MIN_LITERAL_SECRET_LENGTH = 8;

export const PROFILE_LITERAL_CATEGORY = 'provider-credential';

const BATCH_MAX_CHARS = 1024 * 1024;

const MARKER = /⟦REDACTED:([^:⟧]+):([^⟧]+)⟧/g;

export function literalSecretsRedactor(
  base: KnownSecretBatchRedactor,
  secrets: readonly string[]
): KnownSecretBatchRedactor {
  const literals = [...new Set(secrets.filter((s) => s.length >= MIN_LITERAL_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length
  );
  const replaceAll = (text: string): string => {
    let out = text;
    literals.forEach((secret, i) => {
      if (out.includes(secret)) {
        out = out.split(secret).join(`⟦REDACTED:${PROFILE_LITERAL_CATEGORY}:ps${i + 1}⟧`);
      }
    });
    return out;
  };
  return {
    redact: (texts, signal) => base.redact(texts.map(replaceAll), signal),
  };
}

function markerCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(MARKER)) {
    const category = m[1]!;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return counts;
}

function countAdded(before: string, after: string, counts: { [category: string]: number }): void {
  const pre = markerCounts(before);
  for (const [category, n] of markerCounts(after)) {
    const added = n - (pre.get(category) ?? 0);
    if (added > 0) counts[category] = (counts[category] ?? 0) + added;
  }
}

async function redactBatch(
  batch: readonly string[],
  redactor: KnownSecretBatchRedactor,
  signal: AbortSignal | undefined
): Promise<readonly string[]> {
  let result: readonly string[];
  try {
    result = await redactor.redact(batch, signal);
  } catch {
    throw new TranscriptExportError('redaction-unavailable');
  }
  if (result.length !== batch.length) throw new TranscriptExportError('redaction-unavailable');
  return result;
}

export async function redactProfileTexts(
  texts: readonly string[],
  redactor: KnownSecretBatchRedactor,
  counts: { [category: string]: number },
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = [];
  let start = 0;
  while (start < texts.length) {
    if (signal?.aborted) throw new TranscriptExportError('transfer-aborted');
    let chars = 0;
    let end = start;
    while (end < texts.length) {
      const len = texts[end]!.length;
      if (end > start && chars + len > BATCH_MAX_CHARS) break;
      chars += len;
      end++;
    }
    const batch = texts.slice(start, end);
    const known = await redactBatch(batch, redactor, signal);
    batch.forEach((original, i) => {
      const { text } = redactCredentialPatterns(known[i]!, 'pr', 1, {
        categories: AT_REST_CREDENTIAL_CATEGORIES,
      });
      countAdded(original, text, counts);
      out.push(text);
    });
    start = end;
  }
  return out;
}
