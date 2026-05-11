#!/usr/bin/env node
/**
 * Generate pinned mask vectors for cross-implementation parity tests.
 *
 * Runs the canonical TS `mask` over a handful of (sessionId, name, value)
 * tuples and prints one JSON line per vector. The pinned `expected` values
 * land in:
 *   - packages/shared/tests/cross-impl-vectors.test.ts (TS)
 *   - packages/swift-server/Tests/CrossImplementationTests.swift (Swift)
 *
 * Regenerate after intentional masking changes; both test files must be
 * kept in lockstep with the output of this script.
 *
 * Usage:
 *   node packages/dev-tools/tools/gen-mask-vectors.mjs
 */
import { mask } from '../../shared/dist/secret-masking.js';

const vectors = [
  { sessionId: 'session-cross-impl-1', name: 'GITHUB_TOKEN', value: 'ghp_realToken123' },
  { sessionId: 'session-cross-impl-2', name: 'AWS_KEY', value: 'AKIAEXAMPLE' },
  { sessionId: '', name: 'X', value: '' },
  { sessionId: 'session-😀', name: 'Y', value: 'value with spaces' },
];

for (const v of vectors) {
  const expected = await mask(v.sessionId, v.name, v.value);
  console.log(JSON.stringify({ ...v, expected }));
}
