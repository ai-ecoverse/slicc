import { describe, it, expect } from 'vitest';
import { mask } from '../src/secret-masking.js';

/**
 * Pinned cross-implementation mask vectors.
 *
 * The same vectors are pinned in
 * `packages/swift-server/Tests/CrossImplementationTests.swift`.
 *
 * Regenerate with:
 *   npm run build -w @slicc/shared-ts
 *   node packages/dev-tools/tools/gen-mask-vectors.mjs
 *
 * Update BOTH this file and the Swift sibling whenever the masking
 * algorithm changes intentionally. A drift between the two implementations
 * causes silent unmask failures in the fetch proxy.
 */
const PINNED = [
  {
    sessionId: 'session-cross-impl-1',
    name: 'GITHUB_TOKEN',
    value: 'ghp_realToken123',
    expected: 'ghp_25243876bf81',
  },
  {
    sessionId: 'session-cross-impl-2',
    name: 'AWS_KEY',
    value: 'AKIAEXAMPLE',
    expected: 'AKIAc418a4f',
  },
  {
    sessionId: '',
    name: 'X',
    value: '',
    expected: '',
  },
  {
    sessionId: 'session-😀',
    name: 'Y',
    value: 'value with spaces',
    expected: '3a7af4ae08a5ccb55',
  },
  // Pin the UTF-16 code-unit length contract: an emoji is 2 code units
  // in JS String.length (`tok🎉end` = 8), 1 grapheme in Swift String.count
  // (= 7). Swift uses `.utf16.count` for parity; this vector catches a
  // regression to grapheme-counting in either implementation.
  {
    sessionId: 'session-utf16',
    name: 'EMOJI_VALUE',
    value: 'tok🎉end',
    expected: 'd2317bc7',
  },
];

describe('cross-implementation mask vectors', () => {
  it.each(PINNED)(
    'mask($sessionId, $name) is stable',
    async ({ sessionId, name, value, expected }) => {
      expect(await mask(sessionId, name, value)).toBe(expected);
    }
  );
});
