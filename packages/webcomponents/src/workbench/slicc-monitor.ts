import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';

/**
 * A row in the monitor: a resource with status, name, and metadata.
 */
export interface MonitorRow {
  name: string;
  meta: string;
  active?: boolean;
  error?: boolean;
}

/**
 * A collapsible section in the monitor dashboard with count badge and rows.
 */
export interface MonitorSection {
  id: string;
  label: string;
  count: number;
  rows: MonitorRow[];
  meta?: string;
}

const COLLAPSE_KEY = 'slicc_monitor_collapsed';

function getCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function setCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Scoped, document-level stylesheet for `<slicc-monitor>`. A light-DOM
 * component can't carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the host
 * tag + BEM-ish hooks below.
 *
 * Lifted from the prototype monitor panel: a scrollable dashboard of collapsible
 * sections with count badges, status dots (green active, red error, grey default),
 * and a refresh toolbar. All colors come from inherited prototype tokens.
 */
const STYLE = `
slicc-monitor {
  display: block;
  font-family: var(--ui);
  font-size: 13px;
  color: var(--ink);
  overflow: auto;
  padding: 12px;
}
.monitor-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  margin: -12px -12px 12px;
  background: var(--canvas);
  position: sticky;
  top: -12px;
  z-index: 1;
}
.monitor-toolbar__refresh {
  font-family: var(--ui);
  font-size: 12px;
  padding: 4px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--canvas);
  color: var(--ink);
  cursor: pointer;
  transition: background 0.1s ease;
}
.monitor-toolbar__refresh:hover {
  background: var(--ghost);
}
.monitor-toolbar__refresh:active {
  opacity: 0.6;
}
.monitor-section {
  margin-bottom: 16px;
}
.monitor-section--empty {
  opacity: 0.5;
}
.monitor-section__header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--canvas);
  cursor: pointer;
  font-family: var(--ui);
  font-size: 13px;
  color: var(--ink);
  transition: background 0.1s ease;
  text-align: left;
}
.monitor-section__header:hover {
  background: var(--ghost);
}
.monitor-section__toggle {
  color: var(--txt-3);
  font-size: 10px;
  flex-shrink: 0;
}
.monitor-section__title {
  font-weight: 600;
}
.monitor-section__meta {
  margin-left: auto;
  color: var(--txt-3);
  font-size: 11px;
}
.monitor-section__count {
  flex-shrink: 0;
  background: color-mix(in srgb, var(--ctx) 12%, var(--canvas));
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--txt-2);
}
.monitor-section__body {
  padding: 8px 0 0;
}
.monitor-section__body[hidden] {
  display: none;
}
.monitor-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 6px;
  transition: background 0.1s ease;
}
.monitor-row:hover {
  background: var(--ghost);
}
.monitor-row__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--txt-3);
  flex-shrink: 0;
}
.monitor-row__dot--active {
  background: #10b981;
}
.monitor-row__dot--error {
  background: var(--rose);
}
.monitor-row__name {
  font-weight: 500;
  color: var(--ink);
}
.monitor-row__meta {
  margin-left: auto;
  color: var(--txt-3);
  font-size: 11px;
}
`;

const STYLE_ID = 'slicc-monitor-style';

/** Inject the scoped monitor stylesheet into a document once (idempotent). */
function ensureMonitorStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function createRow(row: MonitorRow): HTMLElement {
  const dotClass = row.error
    ? 'monitor-row__dot monitor-row__dot--error'
    : row.active
      ? 'monitor-row__dot monitor-row__dot--active'
      : 'monitor-row__dot';

  return h(
    'div',
    { class: 'monitor-row' },
    h('span', { class: dotClass }),
    h('span', { class: 'monitor-row__name' }, row.name),
    h('span', { class: 'monitor-row__meta' }, row.meta)
  );
}

function createSection(
  section: MonitorSection,
  collapsed: Set<string>,
  onToggle: (id: string) => void
): HTMLElement {
  const isCollapsed = collapsed.has(section.id);
  const sectionClass =
    section.count === 0 ? 'monitor-section monitor-section--empty' : 'monitor-section';

  const headerChildren: (string | HTMLElement)[] = [
    h('span', { class: 'monitor-section__toggle' }, isCollapsed ? '▸' : '▾'),
    h('span', { class: 'monitor-section__title' }, section.label),
  ];

  if (section.meta) {
    headerChildren.push(h('span', { class: 'monitor-section__meta' }, section.meta));
  }

  headerChildren.push(h('span', { class: 'monitor-section__count' }, String(section.count)));

  const header = h(
    'button',
    { class: 'monitor-section__header', type: 'button' },
    ...headerChildren
  );
  header.setAttribute('aria-expanded', String(!isCollapsed));
  header.addEventListener('click', () => onToggle(section.id));

  const body = h('div', { class: 'monitor-section__body' });
  if (isCollapsed) body.setAttribute('hidden', '');

  for (const row of section.rows) {
    body.appendChild(createRow(row));
  }

  return h('div', { class: sectionClass, 'data-section': section.id }, header, body);
}

/**
 * `<slicc-monitor>` — the monitor dashboard from the workbench. A scrollable
 * panel of collapsible sections showing scoops, processes, cron tasks, webhooks,
 * mounts, MCP servers, OAuth providers, workflows, and cost. Each section has a
 * count badge and status-dot rows (green active, red error, grey default).
 *
 * Light DOM (no shadow root): the host renders its toolbar and sections into
 * itself so the host app can style and slot content. The scoped stylesheet is
 * injected once into the host document.
 *
 * Collapse state persists in localStorage (`slicc_monitor_collapsed`).
 *
 * @fires slicc-monitor-refresh - the refresh button was clicked
 */
export class SliccMonitor extends HTMLElement {
  #sections: MonitorSection[] = [];
  #collapsed = new Set<string>();
  #initialized = false;

  connectedCallback(): void {
    ensureMonitorStyle(this.ownerDocument);
    if (!this.#initialized) {
      this.#collapsed = getCollapsed();
      this.#initialized = true;
    }
    if (this.#sections.length > 0) this.#render();
  }

  /** The monitor sections (returns a copy). */
  get sections(): MonitorSection[] {
    return this.#sections.map((s) => ({ ...s, rows: s.rows.slice() }));
  }

  set sections(value: MonitorSection[]) {
    this.#sections = Array.isArray(value) ? value.map((s) => ({ ...s, rows: s.rows.slice() })) : [];
    if (this.isConnected) this.#render();
  }

  #render(): void {
    const toolbar = h(
      'div',
      { class: 'monitor-toolbar' },
      h('button', { class: 'monitor-toolbar__refresh', type: 'button' }, '↻ Refresh')
    );

    const refreshBtn = toolbar.querySelector('.monitor-toolbar__refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('slicc-monitor-refresh', {
            bubbles: true,
            composed: true,
          })
        );
      });
    }

    const nodes: Node[] = [toolbar];

    for (const section of this.#sections) {
      nodes.push(
        createSection(section, this.#collapsed, (id: string) => {
          if (this.#collapsed.has(id)) this.#collapsed.delete(id);
          else this.#collapsed.add(id);
          setCollapsed(this.#collapsed);
          this.#render();
        })
      );
    }

    this.replaceChildren();
    append(this, nodes);
  }
}

define('slicc-monitor', SliccMonitor);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-monitor': SliccMonitor;
  }
}
