/**
 * Tests for the base64 candidate heuristic.
 *
 * The load-bearing property is RESTRAINT. Downstream, a confirmed candidate is
 * elided — replaced by a chip — so a false positive hides text somebody typed.
 * Most of what follows is therefore about what this module refuses to match.
 */

import { uint8ToBase64 } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { findBase64Mentions, MIN_PAYLOAD_CHARS } from '../../src/core/base64-mentions.js';

/** An unpadded base64 run of exactly `chars` alphabet characters. */
function run(chars: number, fill = 'A'): string {
  return fill.repeat(chars);
}

/** Base64 of `bytes` repeated to comfortably clear the length bar. */
function encoded(text: string): string {
  const bytes = new TextEncoder().encode(text.repeat(Math.ceil(300 / text.length)));
  return uint8ToBase64(bytes);
}

describe('findBase64Mentions', () => {
  it('finds a long bare run', () => {
    const payload = encoded('hello world ');
    const found = findBase64Mentions(`here it is: ${payload} — enjoy`);
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toBe(payload);
    expect(found[0]?.declaredMime).toBeUndefined();
  });

  it('reports the span the run occupies', () => {
    const payload = encoded('hello world ');
    const text = `prefix ${payload} suffix`;
    const [found] = findBase64Mentions(text);
    expect(found).toBeDefined();
    expect(text.slice(found!.start, found!.end)).toBe(payload);
  });

  it('carries the MIME type a data: URL declares', () => {
    const payload = encoded('png-ish bytes ');
    const found = findBase64Mentions(`look: data:image/png;base64,${payload}`);
    expect(found).toHaveLength(1);
    expect(found[0]?.declaredMime).toBe('image/png');
    expect(found[0]?.data).toBe(payload);
  });

  it('tolerates data: URL parameters between the type and the encoding', () => {
    const payload = encoded('charset carrier ');
    const found = findBase64Mentions(`data:text/plain;charset=utf-8;base64,${payload}`);
    expect(found).toHaveLength(1);
    expect(found[0]?.declaredMime).toBe('text/plain');
  });

  it('does not also report a data: URL payload as a bare run', () => {
    const payload = encoded('claimed once ');
    const found = findBase64Mentions(`data:image/png;base64,${payload}`);
    expect(found).toHaveLength(1);
  });

  it('finds several payloads in order', () => {
    const first = encoded('first ');
    const second = encoded('second ');
    const found = findBase64Mentions(`${first} and then ${second}`);
    expect(found.map((c) => c.data)).toEqual([first, second]);
  });

  it('finds two runs separated by a single character', () => {
    const payload = run(MIN_PAYLOAD_CHARS);
    // The leading boundary is consumed, so a one-character gap is the case
    // that would break if the trailing boundary were consumed too.
    expect(findBase64Mentions(`${payload} ${payload}`)).toHaveLength(2);
  });

  // -- what it refuses --

  it('ignores a run shorter than the minimum', () => {
    expect(findBase64Mentions(`x ${run(MIN_PAYLOAD_CHARS - 4)} y`)).toEqual([]);
  });

  it('ignores a sha256 hex digest', () => {
    const digest = 'a'.repeat(64);
    expect(findBase64Mentions(`sha256:${digest}`)).toEqual([]);
  });

  it('ignores a run that is not a whole number of base64 quanta', () => {
    expect(findBase64Mentions(` ${'A'.repeat(MIN_PAYLOAD_CHARS + 1)} `)).toEqual([]);
  });

  it('ignores a run containing a character outside the alphabet', () => {
    // `-` is base64url, which `atob` does not accept; the run splits around it
    // and neither half clears the length bar.
    const half = 'A'.repeat(MIN_PAYLOAD_CHARS / 2);
    expect(findBase64Mentions(` ${half}-${half} `)).toEqual([]);
  });

  it('ignores the middle segment of a JWT', () => {
    // `header.payload.signature` — a dot opens nothing, so the segment between
    // two of them is never elided out from between its neighbours.
    const segment = 'A'.repeat(MIN_PAYLOAD_CHARS);
    expect(findBase64Mentions(`eyJhbGciOiJIUzI1NiJ9.${segment}.${segment}`)).toEqual([]);
  });

  it('still matches a payload that ends a sentence', () => {
    // The same dot CLOSES a run: prose puts a period after a pasted blob.
    const payload = encoded('sentence final ');
    expect(findBase64Mentions(`here it is: ${payload}.`)).toHaveLength(1);
  });

  it('ignores a run bounded by the base64url alphabet', () => {
    const segment = 'A'.repeat(MIN_PAYLOAD_CHARS);
    expect(findBase64Mentions(`x_${segment}_y`)).toEqual([]);
  });

  it('does not join two runs across a space', () => {
    const half = 'A'.repeat(MIN_PAYLOAD_CHARS);
    const found = findBase64Mentions(`${half} ${half}`);
    expect(found).toHaveLength(2);
    expect(found[0]?.raw).toBe(half);
  });

  it('finds nothing in ordinary prose', () => {
    expect(findBase64Mentions('Rewrote the watcher in check.js and re-ran the suite.')).toEqual([]);
  });

  it('is not left dirty by a previous call', () => {
    const payload = encoded('sticky lastIndex ');
    const text = `x ${payload} y`;
    expect(findBase64Mentions(text)).toHaveLength(1);
    expect(findBase64Mentions(text)).toHaveLength(1);
  });
});

describe('findBase64Mentions — column-wrapped output', () => {
  /** What `base64 --wrap=<cols>` writes: fixed-width lines, then a remainder. */
  function wrapped(text: string, cols: number): string {
    const payload = encoded(text);
    const lines: string[] = [];
    for (let i = 0; i < payload.length; i += cols) lines.push(payload.slice(i, i + cols));
    return lines.join('\n');
  }

  it('reassembles the default 76-column shape', () => {
    // The advertised `base64 < report.pdf` scenario: every individual line is
    // 76 characters, well under the length bar, so line-at-a-time matching
    // finds nothing at all.
    const block = wrapped('wrapped payload ', 76);
    expect(block.split('\n').length).toBeGreaterThan(2);
    expect(block.split('\n').every((l) => l.length <= 76)).toBe(true);

    const found = findBase64Mentions(`here it is:\n${block}\ndone`);
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toBe(encoded('wrapped payload '));
  });

  it('reassembles the 64-column PEM shape', () => {
    const found = findBase64Mentions(wrapped('pem body ', 64));
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toBe(encoded('pem body '));
  });

  it('reports a span covering the whole block but no surrounding newlines', () => {
    const block = wrapped('span check ', 76);
    const text = `before\n${block}\nafter`;
    const [found] = findBase64Mentions(text);
    expect(found).toBeDefined();
    expect(text.slice(found!.start, found!.end)).toBe(block);
  });

  it('handles CRLF line endings', () => {
    const block = wrapped('crlf payload ', 76).split('\n').join('\r\n');
    const found = findBase64Mentions(block);
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toBe(encoded('crlf payload '));
  });

  it('reports the block once, not also as bare runs', () => {
    // A wide wrap column clears the bare-run threshold on its own, so the
    // block has to claim its lines before the bare-run pass sees them.
    const found = findBase64Mentions(wrapped('wide columns ', 200));
    expect(found).toHaveLength(1);
  });

  // -- what it refuses --

  it('ignores lines of differing width', () => {
    // Real encoders wrap on a fixed column. Ragged lines are prose.
    const lines = ['A'.repeat(76), 'B'.repeat(72), 'C'.repeat(76), 'D'.repeat(80)];
    expect(findBase64Mentions(lines.join('\n'))).toEqual([]);
  });

  it('ignores a block whose width is not a whole number of quanta', () => {
    const lines = ['A'.repeat(75), 'B'.repeat(75), 'C'.repeat(75)];
    expect(findBase64Mentions(lines.join('\n'))).toEqual([]);
  });

  it('ignores narrow equal-width columns', () => {
    // Below MIN_WRAP_COLUMNS a coincidental column of short tokens is far more
    // likely than an encoder that chose to wrap there.
    const lines = Array.from({ length: 40 }, () => 'ABCD');
    expect(findBase64Mentions(lines.join('\n'))).toEqual([]);
  });

  it('ignores a block that is too short overall', () => {
    const lines = ['A'.repeat(32), 'B'.repeat(32)];
    expect(findBase64Mentions(lines.join('\n'))).toEqual([]);
  });

  it('ignores wrapped prose', () => {
    const prose = [
      'The quick brown fox jumps over the lazy dog and then it keeps going on',
      'and on until the line is long enough to look a little bit like a block.',
    ];
    expect(findBase64Mentions(prose.join('\n'))).toEqual([]);
  });

  it("claims a block whose first line carries the user's own words", () => {
    // `here it is: <paste>` — the encoder still wrapped on the same column, it
    // just did not get the whole first line to itself. Claiming from the
    // SECOND line instead would elide most of the payload and strand its first
    // 76 characters as text beside the chip.
    const block = wrapped('mid line ', 76);
    const found = findBase64Mentions(`here it is: ${block}`);
    expect(found).toHaveLength(1);
    expect(found[0]?.data).toBe(encoded('mid line '));
    expect(found[0]?.start).toBe('here it is: '.length);
  });

  it('does not glue on a preceding run that is not wrap-aligned', () => {
    // A trailing run WIDER than the wrap column means the line was never
    // wrapped at that column, so joining it would be a guess.
    const block = wrapped('unaligned ', 76);
    const found = findBase64Mentions(`${'Z'.repeat(90)} ${block}`);
    expect(found).toHaveLength(1);
    expect(found[0]?.start).toBe(91);
  });
});
