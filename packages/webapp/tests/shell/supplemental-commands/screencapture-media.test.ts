import { describe, expect, it } from 'vitest';
import {
  clampVideoDurationMs,
  describeDisplayCaptureError,
} from '../../../src/shell/supplemental-commands/screencapture-media-shared.js';

describe('screencapture-media helpers', () => {
  it('clamps video duration to 100ms–60s with a 5s default', () => {
    expect(clampVideoDurationMs(undefined)).toBe(5_000);
    expect(clampVideoDurationMs(50)).toBe(100);
    expect(clampVideoDurationMs(120_000)).toBe(60_000);
    expect(clampVideoDurationMs(12_500)).toBe(12_500);
  });

  it('rewrites InvalidStateError into an actionable message (#3233)', () => {
    const msg = describeDisplayCaptureError(new DOMException('Invalid state', 'InvalidStateError'));
    expect(msg).toContain('display capture unavailable');
    expect(msg).toContain('reload the session');
  });

  it('maps NotAllowedError to the cancelled/denied phrasing', () => {
    expect(describeDisplayCaptureError(new DOMException('denied', 'NotAllowedError'))).toBe(
      'user cancelled or permission denied'
    );
  });
});
