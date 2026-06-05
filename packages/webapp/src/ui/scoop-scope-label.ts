/**
 * Per-scoop "working scope" label cache.
 *
 * Wraps `quickLabel` so the scoops rail / switcher can show a short
 * LLM-summarized phrase describing what each scoop is currently
 * working on. Float-agnostic: callers inject `fetchTranscript(jid)`
 * which yields a flattened recent-transcript string (whatever shape
 * the float can produce — orchestrator-side or stored sessions).
 *
 * Pattern mirrors `chat-panel.ts`'s `refreshSuggestedPlaceholder`
 * and cluster-label cache: AbortController per in-flight call, cache
 * keyed by jid, and signature-based skip so a hover/dropdown-open
 * refresh against an unchanged transcript doesn't burn an LLM call.
 *
 * Never throws to callers; returns `null`/no-ops on any failure or
 * empty input.
 */

import { createLogger } from '../core/logger.js';
import { quickLabel } from './quick-llm.js';

const log = createLogger('scoop-scope-label');

export type FetchTranscript = (jid: string) => Promise<string>;
export type OnResolved = (jid: string, label: string) => void;

interface CacheEntry {
  label: string;
  /** Transcript signature that produced `label`. Cleared by
   *  `invalidate` to force the next `request` to regenerate even
   *  when the transcript is unchanged. */
  signature: string | null;
}

interface InFlight {
  signature: string;
  controller: AbortController;
}

const SYSTEM_PROMPT =
  'You label what an AI coding agent is currently working on with a short noun phrase ' +
  '(<= 6 words) describing the working scope — e.g. "refactoring auth flow" or ' +
  '"writing scope-label tests". Reply with just the phrase. No quotes, no preamble, ' +
  'no trailing period, no list, no code result. If nothing useful comes to mind, ' +
  'reply exactly: idle.';

const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_LABEL_TOKENS = 24;

/** Trim a transcript to the trailing window we'll send to the LLM. */
function clipTranscript(transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= MAX_TRANSCRIPT_CHARS) return trimmed;
  return '…' + trimmed.slice(trimmed.length - MAX_TRANSCRIPT_CHARS);
}

/** Strip wrapping quotes / trailing period; reject "idle" / empty. */
function normalizeLabel(raw: string): string | null {
  let cleaned = raw.trim();
  // Repeatedly peel wrapping quotes / trailing period until stable, so
  // models that wrap the phrase AND end it with a period (e.g.
  // `"writing the docs."`) collapse cleanly instead of leaving a
  // stray period after the closing quote is removed.
  while (true) {
    const stripped = cleaned.replace(/^["']|["']$|\.$/g, '').trim();
    if (stripped === cleaned) break;
    cleaned = stripped;
  }
  if (cleaned.length === 0) return null;
  if (/^idle$/i.test(cleaned)) return null;
  return cleaned;
}

export class ScoopScopeLabeler {
  private readonly fetchTranscript: FetchTranscript;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlight>();

  constructor(fetchTranscript: FetchTranscript) {
    this.fetchTranscript = fetchTranscript;
  }

  /** Synchronous cache lookup. Returns the last successful label or
   *  `null` if nothing has been generated yet (or the most recent
   *  attempt yielded no usable label). */
  getCached(jid: string): string | null {
    return this.cache.get(jid)?.label ?? null;
  }

  /** Force the next `request(jid, …)` to regenerate even if the
   *  transcript hasn't changed. Leaves the previously-cached label
   *  in place so `getCached` keeps returning a stable value while
   *  the regenerate is in flight. */
  invalidate(jid: string): void {
    const entry = this.cache.get(jid);
    if (entry) entry.signature = null;
    // Also abort any in-flight call so the next request truly
    // regenerates from the current transcript, not whatever was in
    // flight when invalidate fired.
    const current = this.inFlight.get(jid);
    if (current) {
      current.controller.abort();
      this.inFlight.delete(jid);
    }
  }

  /** Generate-or-refresh the label for `jid`. Dedupes in-flight
   *  calls (same jid + same transcript signature), skips when the
   *  transcript signature is unchanged since the last successful
   *  label, and never throws. */
  request(jid: string, onResolved: OnResolved): void {
    void this.runRequest(jid, onResolved).catch((err) => {
      log.debug('Unexpected error in request', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async runRequest(jid: string, onResolved: OnResolved): Promise<void> {
    let transcript: string;
    try {
      transcript = await this.fetchTranscript(jid);
    } catch (err) {
      log.debug('fetchTranscript threw', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const clipped = clipTranscript(transcript);
    if (clipped.length === 0) {
      log.debug('Empty transcript — skipping', { jid });
      return;
    }

    const signature = clipped;

    const cached = this.cache.get(jid);
    if (cached?.signature === signature) {
      // Transcript unchanged since the last successful label. Skip
      // the LLM call; the caller already has the right value via
      // `getCached`.
      return;
    }

    const current = this.inFlight.get(jid);
    if (current && current.signature === signature) {
      // Identical-signature call already in flight. Let it land.
      return;
    }
    if (current) {
      current.controller.abort();
      this.inFlight.delete(jid);
    }

    const controller = new AbortController();
    this.inFlight.set(jid, { signature, controller });

    let label: string | null = null;
    try {
      label = await quickLabel({
        system: SYSTEM_PROMPT,
        prompt: `Recent agent transcript:\n${clipped}`,
        maxTokens: MAX_LABEL_TOKENS,
        signal: controller.signal,
      });
    } catch (err) {
      log.debug('quickLabel threw', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
      label = null;
    }

    // The owning in-flight slot may have been replaced or aborted
    // while we awaited. Drop our result if so.
    const stillOwns = this.inFlight.get(jid);
    if (!stillOwns || stillOwns.controller !== controller) return;
    this.inFlight.delete(jid);
    if (controller.signal.aborted) return;

    if (label === null) {
      log.debug('No label from quickLabel', { jid });
      return;
    }

    const normalized = normalizeLabel(label);
    if (!normalized) {
      log.debug('Label rejected after normalization', { jid });
      return;
    }

    this.cache.set(jid, { label: normalized, signature });
    try {
      onResolved(jid, normalized);
    } catch (err) {
      log.debug('onResolved threw', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Pull the last `user: …` block (case-insensitive, lenient on
 *  whitespace) from a flat `role: text` transcript string. Returns an
 *  empty string when no user line is present. Shared by the rail
 *  (`scoops-panel.ts`) and the dropdown switcher (`scoop-switcher.ts`)
 *  so the fallback tooltip line stays consistent across floats. */
export function extractLatestUserPrompt(transcript: string): string {
  const lines = transcript.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^user:\s*(.*)$/i.exec(lines[i] ?? '');
    if (m && m[1].length > 0) return m[1];
  }
  return '';
}

/** Test-only hooks. */
export const __test__ = {
  clipTranscript,
  normalizeLabel,
  SYSTEM_PROMPT,
  MAX_TRANSCRIPT_CHARS,
};
