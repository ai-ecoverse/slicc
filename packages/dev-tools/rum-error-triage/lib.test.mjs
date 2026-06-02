import { describe, expect, it } from 'vitest';
import {
  aggregateCandidates,
  buildErrorQuery,
  DEFAULT_HOSTS,
  fingerprint,
  isNoise,
  normalizeSignature,
  parseFingerprints,
  selectNewCandidates,
} from './lib.mjs';

describe('isNoise', () => {
  it('flags Vite HMR dev-client frames', () => {
    expect(
      isNoise(
        'Object.send@http://localhost:5710/@vite/client:384:15',
        'send was called before connect'
      )
    ).toBe(true);
    expect(isNoise('foo', 'something in vite/dist/client/x')).toBe(true);
  });
  it('does not flag genuine app errors', () => {
    expect(isNoise('notallowederror', "Failed to execute 'writeText' on 'Clipboard'")).toBe(false);
  });
  it('flags contentless errors (no alphanumerics in source or target)', () => {
    expect(isNoise(null, undefined)).toBe(true);
    expect(isNoise('', '')).toBe(true);
    expect(isNoise(' | ', '')).toBe(true);
  });
});

describe('normalizeSignature', () => {
  it('collapses ports, line:col, and urls so the same error groups together', () => {
    const a = normalizeSignature(
      'Object.x@http://localhost:5710/app.js:384:15',
      'TypeError: boom 12'
    );
    const b = normalizeSignature(
      'Object.x@http://localhost:5720/app.js:991:3',
      'TypeError: boom 87'
    );
    expect(a).toBe(b);
  });
  it('keeps distinct errors distinct', () => {
    expect(normalizeSignature('a', 'clipboard write failed')).not.toBe(
      normalizeSignature('a', 'network request failed')
    );
  });
  it('collapses uuids and hex addresses', () => {
    const sig = normalizeSignature('at 0xdeadbeef', 'lost 550e8400-e29b-41d4-a716-446655440000');
    expect(sig).toContain('<hex>');
    expect(sig).toContain('<uuid>');
  });
  it('tolerates null/undefined', () => {
    expect(normalizeSignature(null, null)).toBe('|');
  });
});

describe('fingerprint', () => {
  it('is stable and deterministic for a signature', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).toMatch(/^[0-9a-f]{32}$/);
  });
  it('differs for different signatures', () => {
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
  });
});

describe('parseFingerprints', () => {
  it('extracts rum-fp markers from issue bodies (case-insensitive)', () => {
    const fps = parseFingerprints([
      { body: 'Recurring error.\n<!-- rum-fp:abc123def456 -->' },
      { body: 'Another\nRUM-FP: 0011223344AA' },
      { body: 'no marker here' },
    ]);
    expect(fps.has('abc123def456')).toBe(true);
    expect(fps.has('0011223344aa')).toBe(true);
    expect(fps.size).toBe(2);
  });
  it('handles empty/missing input', () => {
    expect(parseFingerprints([]).size).toBe(0);
    expect(parseFingerprints(undefined).size).toBe(0);
    expect(parseFingerprints([{}]).size).toBe(0);
  });
});

describe('aggregateCandidates', () => {
  const rows = [
    {
      float: 'cli',
      source: 'x@http://localhost:5710/a.js:1:2',
      target: 'boom 1',
      weight: 10,
      time: '2026-05-10T00:00:00Z',
    },
    {
      float: 'cli',
      source: 'x@http://localhost:5720/a.js:9:9',
      target: 'boom 9',
      weight: 10,
      time: '2026-05-12T00:00:00Z',
    },
    {
      float: 'cli',
      source: 'q@http://localhost:5710/@vite/client:3:4',
      target: 'send before connect',
      weight: 10,
      time: '2026-05-11T00:00:00Z',
    },
    {
      float: 'extension',
      source: 'notallowederror',
      target: 'clipboard blocked',
      weight: 5,
      time: '2026-05-09T00:00:00Z',
    },
  ];

  it('groups by normalized signature, sums weight, and drops noise', () => {
    const out = aggregateCandidates(rows);
    // two real groups: the boom* pair (collapsed) and the clipboard one. Vite dropped.
    expect(out).toHaveLength(2);
    const boom = out.find((c) => c.exampleTarget.startsWith('boom'));
    expect(boom.sampled).toBe(2);
    expect(boom.estimated).toBe(20);
    expect(boom.firstSeen).toBe('2026-05-10T00:00:00Z');
    expect(boom.lastSeen).toBe('2026-05-12T00:00:00Z');
  });

  it('sorts by estimated occurrences descending', () => {
    const out = aggregateCandidates(rows);
    expect(out[0].estimated).toBeGreaterThanOrEqual(out[1].estimated);
  });

  it('returns [] for empty/missing input', () => {
    expect(aggregateCandidates([])).toEqual([]);
    expect(aggregateCandidates(undefined)).toEqual([]);
  });
});

describe('selectNewCandidates', () => {
  const rows = [
    {
      float: 'cli',
      source: 'notallowederror',
      target: 'clipboard blocked',
      weight: 5,
      time: '2026-05-09T00:00:00Z',
    },
    {
      float: 'cli',
      source: 'typeerror',
      target: 'undefined is not a function',
      weight: 10,
      time: '2026-05-09T00:00:00Z',
    },
  ];

  it('omits fingerprints that already have an issue', () => {
    const all = aggregateCandidates(rows);
    const filed = new Set([all[0].fingerprint]);
    const fresh = selectNewCandidates(rows, filed);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].fingerprint).toBe(all[1].fingerprint);
  });

  it('returns all candidates when nothing has been filed', () => {
    expect(selectNewCandidates(rows, new Set())).toHaveLength(2);
    expect(selectNewCandidates(rows, undefined)).toHaveLength(2);
  });
});

describe('buildErrorQuery', () => {
  it('embeds the look-back window, hosts, and SLICC fingerprint filters', () => {
    const sql = buildErrorQuery({ sinceDays: 3, hosts: ['localhost', 'extid'] });
    expect(sql).toContain('INTERVAL 3 DAY');
    expect(sql).toContain('"localhost"');
    expect(sql).toContain('"extid"');
    expect(sql).toContain('checkpoint = "error"');
    // Matches telemetry.ts RUM_GENERATION format exactly (hyphen), not a loose prefix.
    expect(sql).toContain('generation LIKE "slicc-%"');
    expect(sql).not.toContain('generation LIKE "slicc%"');
    expect(sql).toContain('NOT LIKE "%@vite/client%"');
  });

  it('classifies floats by navigate target before the generation marker', () => {
    const sql = buildErrorQuery();
    // CLI/Electron must be matched on their navigate target ahead of the
    // generation fallback, so a slicc-* generation never mislabels them.
    const cliIdx = sql.indexOf('target="cli"');
    const electronIdx = sql.indexOf('target="electron"');
    const genIdx = sql.indexOf('generation LIKE "slicc-%") THEN "extension"');
    expect(cliIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(-1);
    expect(cliIdx).toBeLessThan(genIdx);
    expect(electronIdx).toBeLessThan(genIdx);
  });

  it('defaults to a 1-day window over the default hosts', () => {
    const sql = buildErrorQuery();
    expect(sql).toContain('INTERVAL 1 DAY');
    for (const h of DEFAULT_HOSTS) expect(sql).toContain(`"${h}"`);
  });

  it('clamps a sub-day window up to 1 and floors fractional days', () => {
    expect(buildErrorQuery({ sinceDays: 0 })).toContain('INTERVAL 1 DAY');
    expect(buildErrorQuery({ sinceDays: 2.9 })).toContain('INTERVAL 2 DAY');
  });

  it('sanitises host values to guard the interpolated SQL', () => {
    const sql = buildErrorQuery({ hosts: ['localhost"; DROP TABLE x; --'] });
    expect(sql).not.toContain('DROP TABLE');
  });
});
