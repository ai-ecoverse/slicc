/**
 * Redaction for the SLICC 7 profile export.
 *
 * Two layers sit on top of six's fail-closed known-secret redactor:
 *
 * - {@link literalSecretsRedactor} adds the secrets that only the page knows
 *   (provider API keys and OAuth tokens from `slicc_accounts`, the GitHub
 *   token, MCP header values). None of them may appear in the zip (G8), so
 *   they are replaced wherever they occur in redacted text, transcripts
 *   included.
 * - {@link redactProfileTexts} runs plain text (workspace files, memory,
 *   `licks.json`) through that redactor plus the high-precision credential
 *   patterns the archive-at-rest path uses, and counts the markers it added.
 */

import { redactCredentialPatterns, TranscriptExportError } from '@slicc/shared-ts';
import { AT_REST_CREDENTIAL_CATEGORIES } from './archive-redaction.js';
import type { KnownSecretBatchRedactor } from './redact.js';

/** Shorter values are not treated as secrets: replacing them would shred ordinary text. */
const MIN_LITERAL_SECRET_LENGTH = 8;
/** Marker category for a page-known secret. */
export const PROFILE_LITERAL_CATEGORY = 'provider-credential';
/** Maximum UTF-16 code units per redactor batch (≈ 1 MiB for ASCII), as in `redact.ts`. */
const BATCH_MAX_CHARS = 1024 * 1024;

const MARKER = /⟦REDACTED:([^:⟧]+):([^⟧]+)⟧/g;

/** Wrap `base` so every value in `secrets` is replaced before `base` runs. */
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

/** Add the markers `after` has beyond `before` to `counts`, by category. */
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

/**
 * Redact `texts` (known secrets, then the at-rest credential patterns) in
 * 1 MiB batches. Adds what it replaced to `counts`. Fails closed: any
 * redactor error throws `redaction-unavailable`.
 */
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
