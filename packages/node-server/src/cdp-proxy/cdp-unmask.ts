/**
 * applyCdpUnmask — Client→Chrome leg unmask gate for the CDP proxy.
 *
 * Parses the outbound CDP frame, looks up the per-session current URL
 * via `CdpSessionUrlTracker`, and delegates whole-token unmasking to
 * the pure `unmaskCdpFrame` helper from @slicc/shared-ts.
 *
 * Security invariants (HARD requirements):
 *   - Unmask is gated on the target tab's CURRENT URL. If the session's
 *     URL is unknown OR its hostname can't be parsed → FAIL CLOSED:
 *     forward the original bytes verbatim, no unmask.
 *   - Domain mismatch is handled inside `unmaskCdpFrame.unmaskBody`:
 *     the masked value passes through untouched.
 *   - Frames larger than `CDP_CLIENT_FRAME_MAX_BYTES` are forwarded
 *     verbatim — parsing a runaway frame to scan for secrets would
 *     amplify the same feedback-loop pressure the Chrome→Client leg
 *     already has to defend against.
 *   - JSON parse errors → forward verbatim. The CDP wire format is
 *     JSON-only in practice, but corrupted/non-JSON bytes are not the
 *     unmasker's problem to surface.
 */

import { type CdpFrame, type SecretsPipeline, unmaskCdpFrame } from '@slicc/shared-ts';
import type { CdpSessionUrlTracker } from './session-url-tracker.js';

/**
 * Hard cap on client→Chrome frames we'll attempt to parse + unmask.
 * Real CDP commands originating from the cone are tiny (a few KB at most
 * for `Runtime.evaluate` payloads); the cap is generous to cover oversize
 * `Runtime.callFunctionOn` argument lists without burning cycles on
 * pathological inputs.
 */
export const CDP_CLIENT_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export interface CdpUnmaskDeps {
  tracker: CdpSessionUrlTracker;
  pipeline: SecretsPipeline;
}

export interface CdpUnmaskResult {
  /** Bytes to forward to Chrome. Same reference as `input` when nothing changed. */
  output: string;
  /** True iff the helper rewrote at least one whole-token field. */
  changed: boolean;
  /**
   * Reason the frame was forwarded verbatim, when applicable. `undefined`
   * means the frame was inspected (and possibly unmasked) successfully.
   * Used by the proxy to emit a single deduped debug line per failure mode.
   */
  skipped?: 'oversized' | 'parse-error' | 'no-method' | 'no-hostname' | 'no-secrets';
}

export function applyCdpUnmask(input: string, deps: CdpUnmaskDeps): CdpUnmaskResult {
  if (input.length > CDP_CLIENT_FRAME_MAX_BYTES) {
    return { output: input, changed: false, skipped: 'oversized' };
  }
  if (!deps.pipeline.hasSecrets()) {
    return { output: input, changed: false, skipped: 'no-secrets' };
  }

  let parsed: CdpFrame;
  try {
    parsed = JSON.parse(input) as CdpFrame;
  } catch {
    return { output: input, changed: false, skipped: 'parse-error' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.method !== 'string') {
    return { output: input, changed: false, skipped: 'no-method' };
  }

  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
  const hostname = deps.tracker.getHostname(sessionId);
  if (!hostname) {
    // FAIL CLOSED — without a resolvable hostname we cannot enforce
    // the per-tab domain gate, so unmasking is not safe.
    return { output: input, changed: false, skipped: 'no-hostname' };
  }

  const { frame, changed } = unmaskCdpFrame(parsed, hostname, deps.pipeline);
  if (!changed) return { output: input, changed: false };
  return { output: JSON.stringify(frame), changed: true };
}
