import { describe, expect, it } from 'vitest';
import {
  createFetchProgressObserver,
  fetchLabel,
  ProgressEmitter,
  type ProgressEvent,
} from '../../../src/shell/progress/index.js';

function setup() {
  let t = 0;
  const seen: ProgressEvent[] = [];
  const emitter = new ProgressEmitter({ sink: (e) => seen.push(e), now: () => t });
  const observer = createFetchProgressObserver(emitter, () => t);
  return { seen, observer, advance: (ms: number) => (t += ms) };
}

describe('fetchLabel', () => {
  it('shows host + path, drops query/credentials, caps length', () => {
    expect(fetchLabel('https://user:pw@example.com/big.tar.gz?token=abc')).toBe(
      '↓ example.com/big.tar.gz'
    );
    expect(fetchLabel('https://example.com/')).toBe('↓ example.com');
    expect(fetchLabel('not a url')).toBe('↓ not a url');
    // Not truncated here — the emitter caps after scrubbing (see capLabel).
    expect(fetchLabel(`https://example.com/${'x'.repeat(200)}`).length).toBe(214);
  });
});

describe('createFetchProgressObserver', () => {
  it('reports determinate progress with an ETA when the total is known', () => {
    const { seen, observer, advance } = setup();
    const url = 'https://example.com/f.bin';
    observer.start(url, 1000);
    advance(300);
    observer.chunk(url, 250, 1000);
    advance(300);
    observer.chunk(url, 500, 1000);
    observer.end(url);
    expect(seen.map((e) => e.phase)).toEqual(['start', 'update', 'update', 'end']);
    expect(seen[0]).toMatchObject({
      fraction: 0,
      total: 1000,
      unit: 'bytes',
      label: '↓ example.com/f.bin',
    });
    expect(seen[1]).toMatchObject({ fraction: 0.25, done: 250 });
    expect(seen[1].etaMs).toBeCloseTo(900);
    expect(seen[2]).toMatchObject({ fraction: 0.5, done: 500 });
    expect(seen[3]).toMatchObject({ phase: 'end', fraction: 1 });
    expect(new Set(seen.map((e) => e.id)).size).toBe(1);
  });

  it('is indeterminate without a total but still carries the byte counter', () => {
    const { seen, observer, advance } = setup();
    const url = 'https://example.com/stream';
    observer.start(url, undefined);
    advance(300);
    observer.chunk(url, 4096, undefined);
    observer.end(url);
    expect(seen[0].fraction).toBeUndefined();
    expect(seen[1]).toMatchObject({ fraction: undefined, done: 4096, etaMs: undefined });
  });

  it('stacks concurrent fetches of the same url and ignores unknown urls', () => {
    const { seen, observer, advance } = setup();
    const url = 'https://example.com/same';
    observer.start(url, 10);
    observer.start(url, 10);
    observer.end(url);
    advance(300);
    observer.chunk(url, 5, 10);
    observer.end(url);
    observer.chunk('https://example.com/other', 1, 1);
    observer.end('https://example.com/other');
    const ids = seen.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
    expect(seen.filter((e) => e.phase === 'end')).toHaveLength(2);
    expect(seen.filter((e) => e.phase === 'update')).toHaveLength(1);
  });

  it('does nothing without a sink', () => {
    const emitter = new ProgressEmitter();
    const observer = createFetchProgressObserver(emitter);
    observer.start('https://example.com/x', 10);
    observer.chunk('https://example.com/x', 5, 10);
    observer.end('https://example.com/x');
    expect(emitter.hasSink()).toBe(false);
  });
});
