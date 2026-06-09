import { beforeEach, describe, expect, it } from 'vitest';
import { SliccChatTable } from '../../src/chat/slicc-chat-table.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** Build a `<tr>` via DOM (so `<tr>`/`<td>` survive) with the prototype tones. */
function compareRow(label: string, was: string, now: string, code = false): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const head = document.createElement('td');
  head.textContent = label;
  const wasCell = document.createElement('td');
  wasCell.className = 'was';
  const nowCell = document.createElement('td');
  nowCell.className = 'now';
  if (code) {
    wasCell.innerHTML = `<code>${was}</code>`;
    nowCell.innerHTML = `<code>${now}</code>`;
  } else {
    wasCell.textContent = was;
    nowCell.textContent = now;
  }
  tr.append(head, wasCell, nowCell);
  return tr;
}

function tableOf(el: SliccChatTable): HTMLTableElement {
  return el.querySelector('table.ctable') as HTMLTableElement;
}

describe('slicc-chat-table', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-chat-table')).toBe(SliccChatTable);
  });

  it('renders into light DOM (no shadow root) with table/head/body parts', () => {
    const el = document.createElement('slicc-chat-table');
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    const table = tableOf(el);
    expect(table).not.toBeNull();
    expect(table.getAttribute('part')).toBe('table');
    expect(table.classList.contains('ctable')).toBe(true);
    expect(el.querySelector('[part="head"]')?.tagName).toBe('THEAD');
    expect(el.querySelector('[part="body"]')?.tagName).toBe('TBODY');
  });

  it('reflects the headers attribute to the array property and back', () => {
    const el = document.createElement('slicc-chat-table');
    document.body.appendChild(el);
    expect(el.headers).toEqual([]);

    el.setAttribute('headers', 'Element, Current, Proposed');
    expect(el.headers).toEqual(['Element', 'Current', 'Proposed']);

    el.headers = ['A', 'B'];
    expect(el.getAttribute('headers')).toBe('A,B');

    el.headers = null;
    expect(el.hasAttribute('headers')).toBe(false);
    expect(el.headers).toEqual([]);
  });

  it('builds a small-caps <thead> row from the headers attribute', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'Element, Current, Proposed');
    document.body.appendChild(el);
    const ths = el.querySelectorAll('thead th');
    expect(Array.from(ths).map((t) => t.textContent)).toEqual(['Element', 'Current', 'Proposed']);
  });

  it('escapes header labels', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', '<script>x</script>, ok');
    document.body.appendChild(el);
    const first = el.querySelector('thead th') as HTMLElement;
    expect(first.querySelector('script')).toBeNull();
    expect(first.textContent).toBe('<script>x</script>');
  });

  it('relocates a slotted <tr slot="head"> into <thead> and data rows into <tbody>', () => {
    const el = document.createElement('slicc-chat-table');
    const head = document.createElement('tr');
    head.setAttribute('slot', 'head');
    for (const label of ['Setting', 'Before', 'After']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    const dataRow = compareRow('Theme', 'light', 'light + dark');
    el.append(head, dataRow);
    document.body.appendChild(el);

    const thead = el.querySelector('thead') as HTMLElement;
    const tbody = el.querySelector('tbody') as HTMLElement;
    expect(thead.contains(head)).toBe(true);
    expect(tbody.contains(dataRow)).toBe(true);
    expect(thead.querySelectorAll('th')).toHaveLength(3);
  });

  it('lets a slotted header row win over the headers attribute', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'X, Y, Z');
    const head = document.createElement('tr');
    head.setAttribute('slot', 'head');
    const th = document.createElement('th');
    th.textContent = 'Only';
    head.appendChild(th);
    el.append(head);
    document.body.appendChild(el);

    const ths = el.querySelectorAll('thead th');
    expect(ths).toHaveLength(1);
    expect(ths[0].textContent).toBe('Only');
  });

  it('renders a default comparison table with .was / .now tones and code chips', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'Element, Current, Proposed');
    el.append(
      compareRow('Canvas', '#0e0e0f', '#faf6f1', true),
      compareRow('Headline', 'mono · 28px', 'Fraunces · 64px')
    );
    document.body.appendChild(el);

    const rows = el.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(el.querySelector('tbody td.was')).not.toBeNull();
    expect(el.querySelector('tbody td.now')).not.toBeNull();
    // Inline <code> chips survive inside cells.
    expect(el.querySelectorAll('tbody td.now code')).toHaveLength(1);
  });

  it('paints the ctable chrome from the prototype tokens (light)', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'Element, Current, Proposed');
    el.append(compareRow('Canvas', '#0e0e0f', '#faf6f1', true));
    document.body.appendChild(el);

    const cs = getComputedStyle(tableOf(el));
    // width:100%, border-collapse, 11px radius, 1px var(--line) border.
    expect(cs.borderCollapse).toBe('collapse');
    expect(cs.borderTopLeftRadius).toBe('11px');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.borderTopStyle).toBe('solid');
    // var(--line) #e5e5e5 in light.
    expect(cs.borderTopColor).toBe('rgb(229, 229, 229)');
  });

  it('paints the small-caps header against the ghost background (light)', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'Element, Current, Proposed');
    document.body.appendChild(el);
    const th = el.querySelector('thead th') as HTMLElement;
    const cs = getComputedStyle(th);
    // var(--ghost) #ececef header, var(--txt-2) #737373 text, 600 weight.
    expect(cs.backgroundColor).toBe('rgb(236, 236, 239)');
    expect(cs.color).toBe('rgb(115, 115, 115)');
    expect(cs.fontWeight).toBe('600');
    expect(cs.fontSize).toBe('11px');
  });

  it('emphasizes the first cell (--ink) and tones the now cell green (#1a7f37)', () => {
    const el = document.createElement('slicc-chat-table');
    el.append(compareRow('Canvas', 'old', 'new'));
    document.body.appendChild(el);

    const firstCell = el.querySelector('tbody td:first-child') as HTMLElement;
    const nowCell = el.querySelector('tbody td.now') as HTMLElement;
    const wasCell = el.querySelector('tbody td.was') as HTMLElement;

    // First cell emphasized: var(--ink) #0a0a0a, weight 500.
    expect(getComputedStyle(firstCell).color).toBe('rgb(10, 10, 10)');
    expect(getComputedStyle(firstCell).fontWeight).toBe('500');
    // .now fixed green #1a7f37, weight 500.
    expect(getComputedStyle(nowCell).color).toBe('rgb(26, 127, 55)');
    expect(getComputedStyle(nowCell).fontWeight).toBe('500');
    // .was muted var(--txt-2) #737373.
    expect(getComputedStyle(wasCell).color).toBe('rgb(115, 115, 115)');
  });

  it('styles inline <code> chips with the mono ghost-chip treatment', () => {
    const el = document.createElement('slicc-chat-table');
    el.append(compareRow('Canvas', '#0e0e0f', '#faf6f1', true));
    document.body.appendChild(el);
    const code = el.querySelector('tbody td.now code') as HTMLElement;
    const cs = getComputedStyle(code);
    expect(cs.backgroundColor).toBe('rgb(236, 236, 239)'); // var(--ghost)
    expect(cs.borderTopLeftRadius).toBe('5px');
    expect(cs.fontFamily.toLowerCase()).toContain('mono');
  });

  it('flips the chrome to the dark tokens under a dark scope', () => {
    const wrap = document.createElement('div');
    wrap.className = 'dark';
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'Element, Current, Proposed');
    el.append(compareRow('Canvas', 'old', 'new'));
    wrap.appendChild(el);
    document.body.appendChild(wrap);

    // var(--line) #2a2a2e border, var(--ghost) #1f1f22 header in dark.
    expect(getComputedStyle(tableOf(el)).borderTopColor).toBe('rgb(42, 42, 46)');
    const th = el.querySelector('thead th') as HTMLElement;
    expect(getComputedStyle(th).backgroundColor).toBe('rgb(31, 31, 34)');
    // .now stays a fixed green in dark too.
    const nowCell = el.querySelector('tbody td.now') as HTMLElement;
    expect(getComputedStyle(nowCell).color).toBe('rgb(26, 127, 55)');
    // var(--ink) #f5f5f2 first cell in dark.
    const firstCell = el.querySelector('tbody td:first-child') as HTMLElement;
    expect(getComputedStyle(firstCell).color).toBe('rgb(245, 245, 242)');
  });

  it('fires a composed, bubbling slicc-chat-table-change event on headers change', () => {
    const el = document.createElement('slicc-chat-table');
    document.body.appendChild(el);
    let detail: { headers: string[] } | null = null;
    document.body.addEventListener('slicc-chat-table-change', (e) => {
      detail = (e as CustomEvent<{ headers: string[] }>).detail;
    });
    el.headers = ['Element', 'Current', 'Proposed'];
    expect(detail).toEqual({ headers: ['Element', 'Current', 'Proposed'] });

    detail = null;
    el.headers = null;
    expect(detail).toEqual({ headers: [] });
  });

  it('re-renders the attribute-driven header row when headers change live', () => {
    const el = document.createElement('slicc-chat-table');
    el.setAttribute('headers', 'A, B');
    document.body.appendChild(el);
    expect(el.querySelectorAll('thead th')).toHaveLength(2);

    el.headers = ['A', 'B', 'C'];
    expect(Array.from(el.querySelectorAll('thead th')).map((t) => t.textContent)).toEqual([
      'A',
      'B',
      'C',
    ]);

    el.headers = null;
    expect(el.querySelectorAll('thead th')).toHaveLength(0);
  });
});
