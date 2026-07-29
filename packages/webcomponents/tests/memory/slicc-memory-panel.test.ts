import { beforeEach, describe, expect, it } from 'vitest';
import { REDACTED_REAL_WORLD_MEMORY_MARKDOWN } from '../../src/memory/redacted-real-world-memory-fixture.js';
import { SliccMemoryPanel } from '../../src/memory/slicc-memory-panel.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function row(heading: string, section: string, tag = 'project'): HTMLElement {
  const el = document.createElement('slicc-memrow');
  el.setAttribute('heading', heading);
  el.setAttribute('summary', `${heading} supporting detail`);
  el.setAttribute('section', section);
  el.setAttribute('tag', tag);
  return el;
}

function mount(): SliccMemoryPanel {
  const panel = document.createElement('slicc-memory-panel') as SliccMemoryPanel;
  document.body.append(panel);
  return panel;
}

function realWorldRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let section = 'General';
  let subsection = '';
  for (const line of REDACTED_REAL_WORLD_MEMORY_MARKDOWN.split('\n')) {
    const heading = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      if (heading[1].length === 2) {
        section = heading[2];
        subsection = '';
      } else {
        subsection = heading[2];
      }
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const text = bullet[1]
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\\([`*_])/g, '$1');
    const currentSection = [section, subsection].filter(Boolean).join(' / ');
    const el = row(text, currentSection);
    if (/\b(feedback|reviews?|testing|verification)\b/i.test(`${currentSection} ${text}`)) {
      el.setAttribute('tag', 'feedback');
    } else if (/\b(preference|identity|interface|keyboard|accessibility)\b/i.test(text)) {
      el.setAttribute('tag', 'user');
    }
    rows.push(el);
  }
  return rows;
}

describe('slicc-memory-panel', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers and renders a deliberate empty state', () => {
    const panel = mount();
    expect(customElements.get('slicc-memory-panel')).toBe(SliccMemoryPanel);
    expect(panel.textContent).toContain('No memories yet');
    expect(panel.textContent).toContain('Memories extracted from conversations');
  });

  it('groups rows into sections with every section initially open', () => {
    const panel = mount();
    panel.setRows([
      row('keyboard controls', 'Preferences', 'user'),
      row('warm paper', 'Preferences', 'user'),
      row('run lint first', 'Verification', 'feedback'),
    ]);
    const groups = panel.querySelectorAll<HTMLDetailsElement>('details.mp-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].open).toBe(true);
    expect(groups[1].open).toBe(true);
    expect(panel.querySelector('.mp-count')?.textContent).toBe('3 of 3 memories');
  });

  it('searches headings and sections while preserving the focused input', () => {
    const panel = mount();
    panel.setRows([row('warm paper', 'Preferences'), row('run lint first', 'Verification')]);
    const input = panel.querySelector('input[type="search"]') as HTMLInputElement;
    input.focus();
    input.value = 'verification';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(panel.querySelectorAll('slicc-memrow')).toHaveLength(1);
    expect(panel.querySelector('slicc-memrow')?.getAttribute('heading')).toBe('run lint first');
    expect(document.activeElement).toBe(input);
  });

  it('filters by tag and shows a no-results state', () => {
    const panel = mount();
    panel.setRows([row('warm paper', 'Preferences', 'user')]);
    const select = panel.querySelector('select') as HTMLSelectElement;
    select.value = 'feedback';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(panel.textContent).toContain('No matching memories');
    expect(panel.querySelector('.mp-count')?.textContent).toBe('0 of 1 memories');
  });

  it('does not invent a visible tag for an unclassified row', () => {
    const panel = mount();
    const untagged = row('evidence first', 'Auto-extracted (consolidated)');
    untagged.removeAttribute('tag');
    panel.setRows([untagged]);
    const tag = panel.querySelector('slicc-memtag') as HTMLElement;
    expect(getComputedStyle(tag).display).toBe('none');
  });

  it('suppresses each group unique majority tag while preserving ties and global filters', () => {
    const panel = mount();
    panel.setRows([
      ...Array.from({ length: 7 }, (_, index) => row(`project ${index}`, 'One', 'project')),
      ...Array.from({ length: 3 }, (_, index) => row(`feedback ${index}`, 'One', 'feedback')),
      ...Array.from({ length: 3 }, (_, index) => row(`project tie ${index}`, 'Two', 'project')),
      ...Array.from({ length: 3 }, (_, index) => row(`feedback tie ${index}`, 'Two', 'feedback')),
    ]);
    const groups = panel.querySelectorAll<HTMLDetailsElement>('details.mp-group');
    const dominant = groups[0].querySelector(
      'slicc-memrow[tag="project"] slicc-memtag'
    ) as HTMLElement;
    const minority = groups[0].querySelector(
      'slicc-memrow[tag="feedback"] slicc-memtag'
    ) as HTMLElement;
    const tied = groups[1].querySelector('slicc-memrow[tag="project"] slicc-memtag') as HTMLElement;
    const option = panel.querySelector('option[value="project"]') as HTMLOptionElement;
    expect(groups[0].hasAttribute('data-suppress-project')).toBe(true);
    expect(getComputedStyle(dominant).display).toBe('none');
    expect(getComputedStyle(minority).display).not.toBe('none');
    expect(groups[1].hasAttribute('data-suppress-project')).toBe(false);
    expect(getComputedStyle(tied).display).not.toBe('none');
    expect(option.hidden).toBe(false);
    expect(option.disabled).toBe(false);
  });

  it('renders the real-world fixture with bounded titles, useful tags, and a derived count', () => {
    const panel = mount();
    panel.style.cssText = 'width:520px;height:760px';
    panel.setRows(realWorldRows());
    expect(panel.querySelector('input')?.placeholder).toBe('Search 105 memories…');

    const renderedTitleLengths = [...panel.querySelectorAll<HTMLElement>('.mt b')].map(
      (title) => title.textContent?.length ?? 0
    );
    expect(Math.max(...renderedTitleLengths)).toBeLessThanOrEqual(96);
    for (const group of panel.querySelectorAll<HTMLElement>('details.mp-group')) {
      const rows = [...group.querySelectorAll<HTMLElement>('slicc-memrow')];
      const counts = new Map<string, number>();
      for (const row of rows) {
        const tag = row.getAttribute('tag') ?? 'none';
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const dominant = [...counts].find(([, count]) => count * 2 > rows.length)?.[0];
      for (const row of rows) {
        const tag = row.querySelector('slicc-memtag') as HTMLElement;
        const hidden = row.getAttribute('tag') === dominant;
        expect(getComputedStyle(tag).display === 'none').toBe(hidden);
      }
    }

    const labels = [...panel.querySelectorAll<HTMLElement>('.mp-section-name, .mp-section-source')];
    expect(labels.every((label) => label.scrollWidth <= label.clientWidth)).toBe(true);
  });

  it('does not expose an iteration selector', () => {
    const panel = mount();
    panel.setRows([row('a', 'One'), row('b', 'Two')]);
    expect(panel.hasAttribute('variant')).toBe(false);
    expect([...panel.querySelectorAll<HTMLDetailsElement>('details')].every((d) => d.open)).toBe(
      true
    );
  });

  it('falls back to a flat list below two distinct sections', () => {
    const panel = mount();
    panel.setRows([
      row('a', 'Auto-extracted (consolidated)'),
      row('b', 'Auto-extracted (consolidated)'),
    ]);
    expect(panel.querySelectorAll('.mp-flat > slicc-memrow')).toHaveLength(2);
    expect(panel.querySelector('details.mp-group')).toBeNull();
  });

  it('formats machine-written section stamps as a date and source chip', () => {
    const panel = mount();
    panel.setRows([
      row('a', 'Auto-extracted (2099-01-03, compaction)'),
      row('b', 'Auto-extracted (2099-02-02, pending-enrichment)'),
    ]);
    const first = panel.querySelector('details.mp-group');
    expect(first?.querySelector('.mp-section-name')?.textContent).toBe('Jan 3, 2099');
    expect(first?.querySelector('.mp-section-source')?.textContent).toBe('compaction');
    expect(first?.querySelector('summary')?.textContent).not.toContain('Auto-extracted');
  });

  it('extracts narrative session metadata into a chip and wraps the residual label', () => {
    const panel = mount();
    panel.style.width = '520px';
    panel.setRows([
      row('a', 'A long narrative topic with issue context (Session Jan 2–Feb 8, 2026)'),
      row('b', 'Another section'),
    ]);
    const first = panel.querySelector('details.mp-group');
    expect(first?.querySelector('.mp-section-name')?.textContent).toBe(
      'A long narrative topic with issue context'
    );
    expect(first?.querySelector('.mp-section-source')?.textContent).toBe(
      'Session Jan 2–Feb 8, 2026'
    );
  });
});
