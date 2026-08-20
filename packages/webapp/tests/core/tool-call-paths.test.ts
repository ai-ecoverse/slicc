/**
 * Tests for harvesting file paths out of tool-call parameters.
 *
 * The property that matters is the DIRECTORY: a hint exists to tell a bare
 * `foo.md` in prose which `foo.md` it means, so anything without a path segment
 * is noise, and anything that is not a real local path (a URL) is worse than
 * noise because it costs a `stat()` to disprove.
 */

import { describe, expect, it } from 'vitest';
import {
  formatPathHints,
  parsePathHints,
  toolCallPathHints,
} from '../../src/core/tool-call-paths.js';

describe('toolCallPathHints', () => {
  it('finds the redirect target of a bash command', () => {
    const hints = toolCallPathHints({
      input: { command: 'echo "test" > /home/lars/foo.md' },
    });
    expect(hints).toContain('/home/lars/foo.md');
  });

  it('finds a structured path parameter whatever the field is called', () => {
    expect(toolCallPathHints({ input: { file_path: '/workspace/docs/plan.md' } })).toEqual([
      '/workspace/docs/plan.md',
    ]);
    expect(toolCallPathHints({ input: { destination: '/workspace/out/bundle.js' } })).toEqual([
      '/workspace/out/bundle.js',
    ]);
  });

  it('reads paths out of an array parameter', () => {
    expect(toolCallPathHints({ input: { paths: ['/workspace/a.ts', '/workspace/b.ts'] } })).toEqual(
      ['/workspace/a.ts', '/workspace/b.ts']
    );
  });

  it('drops bare basenames, which tell the resolver nothing new', () => {
    expect(toolCallPathHints({ input: { path: 'foo.md' } })).toEqual([]);
  });

  it('drops URLs, whose path is not a file on this machine', () => {
    const hints = toolCallPathHints({
      input: { command: 'curl https://example.com/assets/app.js' },
    });
    expect(hints).toEqual([]);
  });

  it('dedupes a path named several times in one call', () => {
    const hints = toolCallPathHints({
      input: { command: 'cp /workspace/a.ts /tmp/a.ts && cat /workspace/a.ts' },
    });
    expect(hints).toEqual(['/workspace/a.ts', '/tmp/a.ts']);
  });

  it('caps how many paths one call can contribute', () => {
    const command = Array.from({ length: 40 }, (_, i) => `/workspace/f${i}.ts`).join(' ');
    expect(toolCallPathHints({ input: { command } }).length).toBeLessThanOrEqual(8);
  });

  it('survives inputs that are not objects at all', () => {
    expect(toolCallPathHints({ input: 'cat /workspace/x.ts' })).toEqual(['/workspace/x.ts']);
    expect(toolCallPathHints({ input: undefined })).toEqual([]);
    expect(toolCallPathHints({ input: null })).toEqual([]);
    expect(toolCallPathHints({ input: 42 })).toEqual([]);
  });
});

describe('path hint serialization', () => {
  it('round-trips through an attribute value', () => {
    const hints = ['/workspace/a.ts', '/home/lars/foo.md'];
    expect(parsePathHints(formatPathHints(hints))).toEqual(hints);
  });

  it('serializes nothing for an empty list, so no attribute is written', () => {
    expect(formatPathHints([])).toBeNull();
  });

  it('reads malformed or missing markup as no hints', () => {
    expect(parsePathHints(null)).toEqual([]);
    expect(parsePathHints('not json')).toEqual([]);
    expect(parsePathHints('{"a":1}')).toEqual([]);
    expect(parsePathHints('[1, "/workspace/a.ts"]')).toEqual(['/workspace/a.ts']);
  });
});
