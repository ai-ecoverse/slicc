import { type CdpFrame, type SecretsPipeline, unmaskCdpFrame } from '@slicc/shared-ts';
import type { CdpSessionUrlTracker } from './session-url-tracker.js';

export const CDP_CLIENT_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export interface CdpUnmaskDeps {
  tracker: CdpSessionUrlTracker;
  pipeline: SecretsPipeline;
}

export interface CdpUnmaskResult {
  output: string;

  changed: boolean;

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
    return { output: input, changed: false, skipped: 'no-hostname' };
  }

  const { frame, changed } = unmaskCdpFrame(parsed, hostname, deps.pipeline);
  if (!changed) return { output: input, changed: false };
  return { output: JSON.stringify(frame), changed: true };
}
