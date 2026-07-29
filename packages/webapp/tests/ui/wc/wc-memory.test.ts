// @vitest-environment jsdom
/**
 * Memory-surface tests: CLAUDE.md markdown → memrow cards.
 */

import 'fake-indexeddb/auto';
import { SYNTHETIC_MEMORY_MARKDOWN } from '@slicc/webcomponents/memory/synthetic-fixture';
import { describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  buildMemoryRows,
  MEMORY_TITLE_MAX,
  parseMemoryRows,
} from '../../../src/ui/wc/wc-memory.js';

describe('parseMemoryRows', () => {
  it('carries headings and nested subsections into rows', () => {
    const rows = parseMemoryRows(
      [
        '# Memory',
        '',
        'Owner: synthetic assistant',
        '',
        '## Preferences',
        '- prefers tabs over spaces',
        '### Interaction details',
        '- keeps keyboard controls visible',
        '## Runtime habits',
        '- prefers native APIs',
      ].join('\n')
    );
    expect(rows.map(({ section, tag }) => ({ section, tag }))).toEqual([
      { section: 'Memory', tag: 'project' },
      { section: 'Preferences', tag: 'user' },
      { section: 'Preferences / Interaction details', tag: 'user' },
      { section: 'Runtime habits', tag: 'project' },
    ]);
  });

  it('preserves prose headers and folds continuation lines', () => {
    const rows = parseMemoryRows(
      [
        '# Memory',
        'Role: synthetic assistant',
        'Folder: /workspace/sandbox',
        '',
        '## Feedback',
        '- prefers tabs over spaces',
        '  in all TS files',
        '- ships on Fridays',
      ].join('\n')
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      title: 'Role: synthetic assistant Folder: /workspace/sandbox',
      section: 'Memory',
    });
    expect(rows[1]).toMatchObject({
      title: 'prefers tabs over spaces in all TS files',
      section: 'Feedback',
      tag: 'feedback',
    });
    expect(rows[2].title).toBe('ships on Fridays');
  });

  it('splits long bullets only at sentence or clause boundaries', () => {
    const [sentence, clause, colon] = parseMemoryRows(
      [
        '- The user maintains a large monorepo with escalating quality gates. Verification runs next.',
        '- Start with the smallest relevant surface — inspect it before changing implementation details.',
        '- Prefer evidence before edits: inspect the rendered state before choosing a change.',
      ].join('\n')
    );
    expect(sentence.title).toBe(
      'The user maintains a large monorepo with escalating quality gates.'
    );
    expect(sentence.summary).toBe('Verification runs next.');
    expect(clause.title).toBe('Start with the smallest relevant surface');
    expect(clause.summary).toBe('inspect it before changing implementation details.');
    expect(colon.title).toBe('Prefer evidence before edits');
    expect(colon.summary).toBe('inspect the rendered state before choosing a change.');
  });

  it('keeps short bullets intact and losslessly caps long bullets without clean breaks', () => {
    const short = 'Keep diffs small.';
    const unbroken = 'x'.repeat(100);
    const rows = parseMemoryRows(`- ${short}\n- ${unbroken}`);
    expect(rows[0]).toMatchObject({ title: short, summary: '' });
    expect(rows[1].title).toHaveLength(MEMORY_TITLE_MAX);
    expect(rows[1].summary).toBe('x'.repeat(100 - MEMORY_TITLE_MAX));
    expect(rows[1].title + rows[1].summary).toBe(unbroken);
  });

  it('falls back to a single row for bullet-less documents', () => {
    expect(parseMemoryRows('just prose, no bullets')).toHaveLength(1);
    expect(parseMemoryRows('')).toHaveLength(0);
    expect(parseMemoryRows('# heading only')).toHaveLength(0);
  });

  it('parses the synthetic fixture with sections and clean rendered text', () => {
    const rows = parseMemoryRows(SYNTHETIC_MEMORY_MARKDOWN);
    expect(rows).toHaveLength(101);
    expect(rows.every((row) => row.section.length > 0)).toBe(true);
    expect(rows.every((row) => !/[`]|\*\*/.test(`${row.title}${row.summary}`))).toBe(true);
    expect(
      rows.find((row) => row.bodyHtml.includes('<strong>Start with evidence</strong>'))
    ).toMatchObject({
      section: 'Working rhythm',
      summary: 'and only then choose whether a code change is warranted.',
    });
  });
});

describe('buildMemoryRows', () => {
  it('renders memrow cards from /workspace/CLAUDE.md', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-memory-${Math.random()}`, wipe: true });
    await fs.mkdir('/workspace');
    await fs.writeFile(
      '/workspace/CLAUDE.md',
      [
        '## Feedback and review',
        '- **Remember** the `milk` and <img src="x" onerror="alert(1)">',
        '- and the cones `<preview mode="safe"> & A > B` <script>alert(1)</script>',
      ].join('\n')
    );
    const rows = await buildMemoryRows(fs);
    expect(rows).toHaveLength(2);
    expect(rows[0].tagName.toLowerCase()).toBe('slicc-memrow');
    expect(rows[0].getAttribute('heading')).toBe('Remember the milk and');
    expect(rows[0].hasAttribute('title')).toBe(false);
    expect(rows[0].getAttribute('section')).toBe('Feedback and review');
    expect(rows[0].getAttribute('tag')).toBe('feedback');
    expect(rows[0].querySelector('strong')?.textContent).toBe('Remember');
    expect(rows[0].querySelector('code')?.textContent).toBe('milk');
    expect(rows[0].querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(rows[1].querySelector('script')).toBeNull();
    expect(rows[1].querySelector('code')?.textContent).toBe('<preview mode="safe"> & A > B');
    expect(rows[1].querySelector('preview')).toBeNull();
    expect(rows.map((row) => row.textContent).join(' ')).not.toMatch(/\*\*|`|alert\(1\)/);
  });

  it('returns no rows when the memory file is missing', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-nomem-${Math.random()}`, wipe: true });
    expect(await buildMemoryRows(fs)).toEqual([]);
  });
});
