#!/usr/bin/env node
/**
 * Generate pinned mask vectors for cross-implementation parity tests.
 *
 * Runs the canonical TS `mask` over a handful of (sessionId, name, value)
 * tuples and prints one JSON line per vector. The pinned `expected` values
 * land in:
 *   - packages/shared-ts/tests/cross-impl-vectors.test.ts (TS)
 *   - packages/swift-server/Tests/CrossImplementationTests.swift (Swift)
 *
 * Regenerate after intentional masking changes; both test files must be
 * kept in lockstep with the output of this script.
 *
 * Usage:
 *   node packages/dev-tools/tools/gen-mask-vectors.mjs
 */
import { mask } from '../../shared-ts/dist/secret-masking.js';

const vectors = [
  { sessionId: 'session-cross-impl-1', name: 'GITHUB_TOKEN', value: 'ghp_realToken123' },
  { sessionId: 'session-cross-impl-2', name: 'AWS_KEY', value: 'AKIAEXAMPLE' },
  { sessionId: '', name: 'X', value: '' },
  { sessionId: 'session-😀', name: 'Y', value: 'value with spaces' },
  // Pin the UTF-16 code-unit length contract: an emoji is 2 code units in
  // JS String.length (`tok🎉end` = 8) but 1 grapheme cluster in Swift
  // String.count (= 7). Swift uses `.utf16.count` for parity. Without
  // this vector, a regression in either implementation reverts to
  // grapheme-length and the shorter masked-value-length silently agrees
  // across tests because neither side covers non-ASCII values.
  { sessionId: 'session-utf16', name: 'EMOJI_VALUE', value: 'tok🎉end' },
];

for (const v of vectors) {
  const expected = await mask(v.sessionId, v.name, v.value);
  console.log(JSON.stringify({ ...v, expected }));
}
