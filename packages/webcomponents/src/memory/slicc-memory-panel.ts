import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';
import './slicc-memrow.js';

const STYLE = `
slicc-memory-panel{display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--canvas);color:var(--ink);font-family:var(--ui)}
slicc-memory-panel .mp-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:12px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--canvas) 94%,var(--violet))}
slicc-memory-panel .mp-search{display:flex;align-items:center;min-width:0;border:1px solid var(--line);border-radius:10px;background:var(--canvas);padding:0 10px}
slicc-memory-panel .mp-search:focus-within{border-color:var(--violet);box-shadow:0 0 0 2px color-mix(in srgb,var(--violet) 18%,transparent)}
slicc-memory-panel .mp-search input{width:100%;height:34px;border:0;outline:0;background:transparent;color:var(--ink);font:12px var(--ui)}
slicc-memory-panel .mp-filter{height:36px;border:1px solid var(--line);border-radius:10px;background:var(--canvas);color:var(--ink);padding:0 28px 0 9px;font:12px var(--ui)}
slicc-memory-panel .mp-count{grid-column:1/-1;color:var(--txt-2);font-size:11px}
slicc-memory-panel .mp-body{flex:1;min-height:0;overflow:auto;padding:10px}
slicc-memory-panel .mp-empty{display:grid;min-height:220px;place-content:center;gap:6px;padding:28px;text-align:center;color:var(--txt-2)}
slicc-memory-panel .mp-empty strong{color:var(--ink);font-size:14px}
slicc-memory-panel details.mp-group{border:1px solid var(--line);border-radius:12px;background:var(--canvas);margin-bottom:9px;overflow:hidden}
slicc-memory-panel summary.mp-section{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none;padding:11px 13px;font-size:12px;font-weight:650}
slicc-memory-panel summary.mp-section::-webkit-details-marker{display:none}
slicc-memory-panel summary.mp-section::before{content:'›';color:var(--violet);font-size:18px;line-height:10px;transform:rotate(0deg);transition:transform .15s ease}
slicc-memory-panel details[open]>summary.mp-section::before{transform:rotate(90deg)}
slicc-memory-panel .mp-section-name{flex:1;min-width:0;overflow-wrap:anywhere;white-space:normal}
slicc-memory-panel .mp-section-source{max-width:45%;border-radius:999px;background:var(--ghost);color:var(--txt-2);padding:2px 7px;font-size:10px;font-weight:500;text-align:right;text-transform:capitalize;overflow-wrap:anywhere;white-space:normal}
slicc-memory-panel .mp-section-count{color:var(--txt-2);font-size:10px;font-weight:500}
slicc-memory-panel .mp-rows{border-top:1px solid var(--line);padding:9px}
slicc-memory-panel .mp-rows slicc-memrow:last-child{margin-bottom:0}
slicc-memory-panel .mp-flat slicc-memrow:last-child{margin-bottom:0}
slicc-memory-panel slicc-memrow:not([tag]) slicc-memtag{display:none}
slicc-memory-panel [data-suppress-user] slicc-memrow[tag="user"] slicc-memtag,
slicc-memory-panel [data-suppress-feedback] slicc-memrow[tag="feedback"] slicc-memtag,
slicc-memory-panel [data-suppress-project] slicc-memrow[tag="project"] slicc-memtag{display:none}
slicc-memory-panel .mp-body{padding:0}
slicc-memory-panel details.mp-group{border-width:0 0 1px;border-radius:0;margin:0}
slicc-memory-panel summary.mp-section{background:var(--ghost);padding:8px 12px;text-transform:uppercase;letter-spacing:.06em;font-size:10px}
slicc-memory-panel .mp-rows{padding:0;border-top:0}
slicc-memory-panel slicc-memrow{border:0;border-radius:0;border-top:1px solid var(--line);margin:0;padding:7px 12px}
slicc-memory-panel slicc-memrow .mt b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
slicc-memory-panel slicc-memrow .ms{-webkit-line-clamp:1;margin-top:2px;font-size:11px}
`;

const STYLE_ID = 'slicc-memory-panel-style';

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).append(style);
}

function sectionOf(row: HTMLElement): string {
  return row.getAttribute('section')?.trim() || 'General';
}

function groupRows(rows: readonly HTMLElement[]): Map<string, HTMLElement[]> {
  const groups = new Map<string, HTMLElement[]>();
  for (const row of rows) {
    const section = sectionOf(row);
    const group = groups.get(section) ?? [];
    group.push(row);
    groups.set(section, group);
  }
  return groups;
}

const MIN_GROUPED_SECTIONS = 2;
const PANEL_TAGS = ['user', 'feedback', 'project'] as const;
type PanelTag = (typeof PANEL_TAGS)[number];

function dominantTag(rows: readonly HTMLElement[]): PanelTag | null {
  for (const tag of PANEL_TAGS) {
    const count = rows.filter((row) => row.getAttribute('tag') === tag).length;
    if (count * 2 > rows.length) return tag;
  }
  return null;
}

function suppressDominantTag(container: HTMLElement, rows: readonly HTMLElement[]): void {
  const tag = dominantTag(rows);
  if (tag) container.setAttribute(`data-suppress-${tag}`, '');
}

interface SectionLabel {
  name: string;
  source: string;
}

function sectionLabel(section: string): SectionLabel {
  const extracted = /^Auto-extracted \((?:(\d{4})-(\d{2})-(\d{2}),\s*)?([^)]+)\)$/.exec(section);
  if (!extracted) {
    const session = /\(([^)]*\bsessions?\b[^)]*)\)/i.exec(section);
    if (!session) return { name: section, source: '' };
    const name =
      `${section.slice(0, session.index)} ${section.slice(session.index + session[0].length)}`
        .replace(/\s+[—–-]\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    return { name: name || 'Session memory', source: session[1] };
  }
  const [, year, month, day, source] = extracted;
  if (!year || !month || !day) return { name: 'Auto-extracted', source };
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return {
    name: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date),
    source: source.replaceAll('-', ' '),
  };
}

/** Searchable, sectioned host for large memory collections. */
export class SliccMemoryPanel extends HTMLElement {
  #rows: HTMLElement[] = [];
  #body: HTMLElement | null = null;
  #count: HTMLElement | null = null;
  #input: HTMLInputElement | null = null;
  #select: HTMLSelectElement | null = null;
  #query = '';
  #tag = 'all';
  #openSections = new Set<string>();
  #initialized = false;

  connectedCallback(): void {
    ensureStyle(this.ownerDocument);
    if (!this.#initialized) this.#initialize();
    this.#render();
  }

  /** Replace the complete memory collection while keeping panel controls stable. */
  setRows(rows: readonly HTMLElement[]): void {
    const previousSections = new Set(groupRows(this.#rows).keys());
    this.#rows = rows.filter((row) => row.matches('slicc-memrow'));
    this.#syncTagOptions();
    const sections = [...groupRows(this.#rows).keys()];
    const nextOpenSections = new Set<string>();
    for (const section of sections) {
      if (!previousSections.has(section) || this.#openSections.has(section)) {
        nextOpenSections.add(section);
      }
    }
    this.#openSections = nextOpenSections;
    if (this.#initialized) this.#render();
  }

  #syncTagOptions(): void {
    const select = this.#select;
    if (!select) return;
    for (const option of select.options) {
      if (option.value === 'all') continue;
      const unavailable = !this.#rows.some((row) => row.getAttribute('tag') === option.value);
      option.hidden = unavailable;
      option.disabled = unavailable;
    }
    select.value = this.#tag;
  }

  #initialize(): void {
    this.#initialized = true;
    const input = h('input', {
      type: 'search',
      placeholder: 'Search memories…',
      'aria-label': 'Search memories',
    }) as HTMLInputElement;
    const select = h(
      'select',
      { class: 'mp-filter', 'aria-label': 'Filter memories by tag' },
      h('option', { value: 'all' }, 'All tags'),
      h('option', { value: 'user' }, 'User'),
      h('option', { value: 'feedback' }, 'Feedback'),
      h('option', { value: 'project' }, 'Project')
    ) as HTMLSelectElement;
    const count = h('div', { class: 'mp-count', role: 'status', 'aria-live': 'polite' });
    const toolbar = h(
      'div',
      { class: 'mp-toolbar' },
      h('label', { class: 'mp-search' }, input),
      select,
      count
    );
    const body = h('div', { class: 'mp-body' });
    input.addEventListener('input', () => {
      this.#query = input.value.trim().toLowerCase();
      this.#render();
    });
    select.addEventListener('change', () => {
      this.#tag = select.value;
      this.#render();
    });
    this.replaceChildren(toolbar, body);
    this.#body = body;
    this.#count = count;
    this.#input = input;
    this.#select = select;
    this.#syncTagOptions();
  }

  #filteredRows(): HTMLElement[] {
    return this.#rows.filter((row) => {
      if (this.#tag !== 'all' && row.getAttribute('tag') !== this.#tag) return false;
      if (!this.#query) return true;
      const text = [
        row.getAttribute('heading'),
        row.getAttribute('summary'),
        row.getAttribute('section'),
        row.getAttribute('tag'),
        row.textContent,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return text.includes(this.#query);
    });
  }

  #empty(filtered: boolean): HTMLElement {
    return h(
      'div',
      { class: 'mp-empty' },
      h('strong', null, filtered ? 'No matching memories' : 'No memories yet'),
      h(
        'span',
        null,
        filtered
          ? 'Try a different search or tag.'
          : 'Memories extracted from conversations will appear here.'
      )
    );
  }

  #details(section: string, rows: readonly HTMLElement[]): HTMLDetailsElement {
    const label = sectionLabel(section);
    const details = h(
      'details',
      { class: 'mp-group' },
      h(
        'summary',
        { class: 'mp-section' },
        h('span', { class: 'mp-section-name' }, label.name),
        ...(label.source ? [h('span', { class: 'mp-section-source' }, label.source)] : []),
        h('span', { class: 'mp-section-count' }, `${rows.length}`)
      ),
      h('div', { class: 'mp-rows' }, ...rows)
    ) as HTMLDetailsElement;
    details.open = this.#query ? true : this.#openSections.has(section);
    details.addEventListener('toggle', () => {
      if (details.open) this.#openSections.add(section);
      else this.#openSections.delete(section);
    });
    suppressDominantTag(details, rows);
    return details;
  }

  #renderFlat(rows: readonly HTMLElement[]): HTMLElement {
    const flat = h('div', { class: 'mp-flat' }, ...rows);
    suppressDominantTag(flat, rows);
    return flat;
  }

  #render(): void {
    const body = this.#body;
    if (!body) return;
    const rows = this.#filteredRows();
    if (this.#input) this.#input.placeholder = `Search ${this.#rows.length} memories…`;
    if (this.#count) this.#count.textContent = `${rows.length} of ${this.#rows.length} memories`;
    if (this.#rows.length === 0) {
      body.replaceChildren(this.#empty(false));
      return;
    }
    if (rows.length === 0) {
      body.replaceChildren(this.#empty(true));
      return;
    }
    const groups = groupRows(rows);
    if (groups.size < MIN_GROUPED_SECTIONS) {
      body.replaceChildren(this.#renderFlat(rows));
      return;
    }
    body.replaceChildren(...[...groups].map(([section, group]) => this.#details(section, group)));
  }
}

define('slicc-memory-panel', SliccMemoryPanel);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-memory-panel': SliccMemoryPanel;
  }
}
