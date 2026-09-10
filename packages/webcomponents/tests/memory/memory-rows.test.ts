import { describe, expect, it } from 'vitest';
import { fixtureRenderMarkdown } from '../../src/memory/fixture-render-markdown.js';
import {
  createMemoryRows,
  MEMORY_TITLE_MAX,
  parseMemoryRows,
} from '../../src/memory/memory-rows.js';
import { SYNTHETIC_MEMORY_MARKDOWN } from '../../src/memory/synthetic-memory-fixture.js';

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
      ].join('\n'),
      fixtureRenderMarkdown
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
      ].join('\n'),
      fixtureRenderMarkdown
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
      ].join('\n'),
      fixtureRenderMarkdown
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
    const rows = parseMemoryRows(`- ${short}\n- ${unbroken}`, fixtureRenderMarkdown);
    expect(rows[0]).toMatchObject({ title: short, summary: '' });
    expect(rows[1].title).toHaveLength(MEMORY_TITLE_MAX);
    expect(rows[1].summary).toBe('x'.repeat(100 - MEMORY_TITLE_MAX));
    expect(rows[1].title + rows[1].summary).toBe(unbroken);
  });

  it('falls back to a single row for bullet-less documents', () => {
    expect(parseMemoryRows('just prose, no bullets', fixtureRenderMarkdown)).toHaveLength(1);
    expect(parseMemoryRows('', fixtureRenderMarkdown)).toHaveLength(0);
    expect(parseMemoryRows('# heading only', fixtureRenderMarkdown)).toHaveLength(0);
  });

  it('parses the synthetic fixture with sections and clean rendered text', () => {
    const rows = parseMemoryRows(SYNTHETIC_MEMORY_MARKDOWN, fixtureRenderMarkdown);
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

  it('leaves auto-extracted rows untagged unless the content matches', () => {
    const [plain, feedback] = parseMemoryRows(
      [
        '## Auto-extracted (consolidated)',
        '- prefers native APIs',
        '- testing observations from the last compaction',
      ].join('\n'),
      fixtureRenderMarkdown
    );
    expect(plain.tag).toBeNull();
    expect(feedback.tag).toBe('feedback');
  });
});

describe('fixtureRenderMarkdown', () => {
  it('turns markdown links into anchors and drops javascript: hrefs', () => {
    const html = fixtureRenderMarkdown(
      'See [the synthetic reference](https://example.invalid/reference) and [xss](javascript:alert(1)).'
    );
    expect(html).toContain(
      '<a href="https://example.invalid/reference" target="_blank" rel="noopener noreferrer">the synthetic reference</a>'
    );
    expect(html).toContain('xss');
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain('href="javascript:');
  });
});

describe('createMemoryRows', () => {
  it('builds slicc-memrow cards with heading, section, and rich title', () => {
    const rows = createMemoryRows(
      ['## Feedback and review', '- **Remember** the `milk`'].join('\n'),
      fixtureRenderMarkdown
    );
    document.body.append(...rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].tagName.toLowerCase()).toBe('slicc-memrow');
    expect(rows[0].getAttribute('heading')).toBe('Remember the milk');
    expect(rows[0].getAttribute('section')).toBe('Feedback and review');
    expect(rows[0].getAttribute('tag')).toBe('feedback');
    expect(rows[0].querySelector('strong')?.textContent).toBe('Remember');
    expect(rows[0].querySelector('code')?.textContent).toBe('milk');
  });

  it('renders the synthetic fixture link as an anchor', () => {
    const rows = createMemoryRows(SYNTHETIC_MEMORY_MARKDOWN, fixtureRenderMarkdown);
    document.body.append(...rows);
    const link = rows
      .map((row) => row.querySelector('a'))
      .find((anchor) => anchor?.textContent === 'the synthetic reference');
    expect(link?.getAttribute('href')).toBe('https://example.invalid/reference');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('escapes raw HTML in the fixture renderer', () => {
    const rows = createMemoryRows(
      '- <img src="x" onerror="alert(1)"> and <script>alert(1)</script>',
      fixtureRenderMarkdown
    );
    document.body.append(...rows);
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[0].querySelector('script')).toBeNull();
    expect(rows[0].textContent).toContain('<img src="x" onerror="alert(1)">');
  });
});
