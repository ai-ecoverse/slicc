// @vitest-environment jsdom
/**
 * Memory-surface tests: CLAUDE.md markdown → memrow cards.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { buildMemoryRows, parseMemoryRows } from '../../../src/ui/wc/wc-memory.js';

describe('parseMemoryRows', () => {
  it('maps one row per bullet, folding continuation lines', () => {
    const rows = parseMemoryRows(
      [
        '# Memory',
        '',
        '- prefers tabs over spaces',
        '  in all TS files',
        '- ships on Fridays',
      ].join('\n')
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('prefers tabs over spaces in all TS files');
    expect(rows[1].title).toBe('ships on Fridays');
  });

  it('splits long bullets into title + summary', () => {
    const long = `the user maintains a very large monorepo with escalating quality gates ${'x'.repeat(40)}`;
    const [row] = parseMemoryRows(`- ${long}`);
    expect(row.title.endsWith('…')).toBe(true);
    expect(row.title.length).toBeLessThanOrEqual(66);
    expect(row.summary.length).toBeGreaterThan(0);
  });

  it('falls back to a single row for bullet-less documents', () => {
    expect(parseMemoryRows('just prose, no bullets')).toHaveLength(1);
    expect(parseMemoryRows('')).toHaveLength(0);
    expect(parseMemoryRows('# heading only')).toHaveLength(1);
  });
});

describe('buildMemoryRows', () => {
  it('renders memrow cards from /workspace/CLAUDE.md', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-memory-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace');
    await fs.writeFile('/workspace/CLAUDE.md', '- remember the milk\n- and the cones');
    const rows = await buildMemoryRows(fs);
    expect(rows).toHaveLength(2);
    expect(rows[0].tagName.toLowerCase()).toBe('slicc-memrow');
    expect(rows[0].getAttribute('title')).toBe('remember the milk');
    expect(rows[0].getAttribute('tag')).toBe('project');
  });

  it('returns no rows when the memory file is missing', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-nomem-${Math.random()}`, wipe: true });
    expect(await buildMemoryRows(fs)).toEqual([]);
  });
});
