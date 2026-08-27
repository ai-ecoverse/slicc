import { describe, expect, it } from 'vitest';
import { successorVersionFromLinkHeader } from '../src/tray-signaling.js';

/**
 * Pinned cross-implementation `successor-version` link vectors (#1957).
 *
 * Four followers parse this header — the browser, the Electron follower, the
 * Go CLI, and the two Swift packages — and a disagreement between them is
 * exactly the class of bug #1956 was: one implementation reads a redirect
 * everyone else follows, dead-ends, and nobody notices until a leader
 * reconnects in the field.
 *
 * The same table is pinned in:
 *   packages/slicc-cli/internal/signaling/link_test.go
 *   packages/swift-trayfollower/Tests/SliccTrayFollowerTests/SupersedeLinkTests.swift
 *   packages/swift-traysession/Tests/SliccTraySessionTests/SupersedeLinkTests.swift
 *
 * Add a case here and to all three siblings, never to just one.
 */
const VECTORS: { name: string; header: string | null; expected: string | null }[] = [
  {
    name: 'the header the worker emits',
    header: '<https://www.sliccy.ai/join/fresh-tray.deadbeef>; rel="successor-version"',
    expected: 'https://www.sliccy.ai/join/fresh-tray.deadbeef',
  },
  {
    name: 'buried in the standard rel set applySliccLinks appends',
    header:
      '<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version", ' +
      '<https://www.sliccy.ai/.well-known/api-catalog>; rel="api-catalog", ' +
      '<https://www.sliccy.ai/status>; rel="status"; type="application/json"',
    expected: 'https://www.sliccy.ai/join/fresh.beef',
  },
  {
    name: 'standard rel set first, successor last',
    header:
      '<https://www.sliccy.ai/status>; rel="status", ' +
      '<https://www.sliccy.ai/join/fresh.beef>; rel="successor-version"',
    expected: 'https://www.sliccy.ai/join/fresh.beef',
  },
  {
    name: 'unquoted rel token',
    header: '<https://www.sliccy.ai/join/a.b>; rel=successor-version',
    expected: 'https://www.sliccy.ai/join/a.b',
  },
  {
    name: 'rel as a space-separated token list',
    header: '<https://www.sliccy.ai/join/a.b>; rel="alternate successor-version"',
    expected: 'https://www.sliccy.ai/join/a.b',
  },
  {
    name: 'rel matching is case-insensitive (RFC 8288 §3.3)',
    header: '<https://www.sliccy.ai/join/a.b>; REL="Successor-Version"',
    expected: 'https://www.sliccy.ai/join/a.b',
  },
  {
    name: 'a comma inside a quoted parameter is not a value separator',
    header:
      '<https://www.sliccy.ai/x>; rel="alternate"; title="one, two", ' +
      '<https://www.sliccy.ai/join/a.b>; rel="successor-version"',
    expected: 'https://www.sliccy.ai/join/a.b',
  },
  {
    name: 'a semicolon inside a quoted parameter does not forge a rel',
    header: '<https://www.sliccy.ai/x>; title="q; rel=successor-version"',
    expected: null,
  },
  {
    name: 'a different version rel is not a successor',
    header: '<https://www.sliccy.ai/join/old.b>; rel="predecessor-version"',
    expected: null,
  },
  {
    name: 'successor-version as a prefix of another token does not match',
    header: '<https://www.sliccy.ai/join/a.b>; rel="successor-version-2"',
    expected: null,
  },
  {
    name: 'a relative target is rejected — a replacement tray is always absolute',
    header: '</join/a.b>; rel="successor-version"',
    expected: null,
  },
  {
    name: 'a percent-encoded target survives verbatim',
    header: '<https://www.sliccy.ai/join/fresh%3Eevil.deadbeef>; rel="successor-version"',
    expected: 'https://www.sliccy.ai/join/fresh%3Eevil.deadbeef',
  },
  { name: 'no header at all', header: null, expected: null },
  { name: 'an empty header', header: '', expected: null },
  { name: 'a garbage header', header: 'not a link header', expected: null },
];

describe('successorVersionFromLinkHeader', () => {
  it.each(VECTORS)('$name', ({ header, expected }) => {
    expect(successorVersionFromLinkHeader(header)).toBe(expected);
  });

  it('merges repeated header instances, however the platform joined them', () => {
    const link = '<https://www.sliccy.ai/join/a.b>; rel="successor-version"';
    const other = '<https://www.sliccy.ai/status>; rel="status"';
    expect(successorVersionFromLinkHeader([other, link])).toBe('https://www.sliccy.ai/join/a.b');
    // CDP joins multi-value headers with a newline rather than a comma.
    expect(successorVersionFromLinkHeader(`${other}\n${link}`)).toBe(
      'https://www.sliccy.ai/join/a.b'
    );
  });

  it('returns the first successor when a hub emits more than one', () => {
    expect(
      successorVersionFromLinkHeader(
        '<https://www.sliccy.ai/join/first.b>; rel="successor-version", ' +
          '<https://www.sliccy.ai/join/second.b>; rel="successor-version"'
      )
    ).toBe('https://www.sliccy.ai/join/first.b');
  });
});
