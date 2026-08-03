import { define } from '../internal/define.js';
import { append, h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export type MonitorStatus = 'active' | 'error' | 'warn' | 'idle';
export type MonitorAccent = 'rose' | 'cyan' | 'violet' | 'amber' | 'waffle' | 'green';

/**
 * A row in the monitor: a resource with status, name, and metadata.
 */
export interface MonitorRow {
  name: string;
  meta: string;
  active?: boolean;
  error?: boolean;
  icon?: string;
  sublabel?: string;
  badges?: string[];
  status?: MonitorStatus;
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
  accent?: MonitorAccent;
  emptyText?: string;
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
  box-sizing: border-box;
  font-family: var(--ui);
  font-size: 13px;
  color: var(--ink);
  background: var(--bg);
  overflow: auto;
  padding: 16px;
  container: monitor / inline-size;
  --monitor-border: color-mix(in srgb, var(--line) 55%, var(--ink));
}
.monitor-summary {
  display: grid;
  gap: 16px;
  padding: 16px;
  margin: -16px -16px 16px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--canvas) 94%, var(--ctx));
  box-shadow: var(--shadow-pane);
  position: sticky;
  top: -16px;
  z-index: 2;
}
.monitor-summary__topline {
  display: flex;
  align-items: center;
  gap: 12px;
}
.monitor-summary__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 12px;
  color: color-mix(in srgb, var(--ctx) 35%, var(--ink));
  background: color-mix(in srgb, var(--ctx) 14%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--ctx) 28%, var(--monitor-border));
}
.monitor-summary__copy {
  min-width: 0;
}
.monitor-summary__title {
  margin: 0;
  color: var(--ink);
  font-size: 16px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.monitor-summary__subtitle {
  margin: 2px 0 0;
  color: var(--txt-2);
  font-size: 12px;
  line-height: 1.4;
}
.monitor-summary__refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  margin-left: auto;
  font-family: var(--ui);
  font-size: 12px;
  font-weight: 600;
  padding: 0 12px;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--canvas);
  color: var(--ink);
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.monitor-summary__refresh:hover {
  background: var(--ghost);
}
.monitor-summary__refresh:active {
  transform: translateY(1px);
}
.monitor-summary__refresh:focus-visible,
.monitor-section__header:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
.monitor-summary__refresh:disabled,
.monitor-section__header:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.monitor-summary__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}
.monitor-summary__metric {
  min-width: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 4%, var(--canvas));
  border: 1px solid var(--line);
}
.monitor-summary__metric dt {
  color: var(--txt-2);
  font-size: 10px;
  line-height: 1.4;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.monitor-summary__metric dd {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 15px;
  line-height: 1.3;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-sections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  align-items: start;
  gap: 16px;
}
.monitor-section {
  --monitor-accent: var(--ctx);
  overflow: hidden;
  border: 1px solid var(--monitor-border);
  border-radius: 12px;
  background: var(--canvas);
  box-shadow: var(--shadow-pane);
}
.monitor-section[data-accent='rose'] { --monitor-accent: var(--rose); }
.monitor-section[data-accent='cyan'] { --monitor-accent: var(--cyan); }
.monitor-section[data-accent='violet'] { --monitor-accent: var(--violet); }
.monitor-section[data-accent='amber'] { --monitor-accent: var(--amber); }
.monitor-section[data-accent='waffle'] { --monitor-accent: var(--waffle); }
.monitor-section[data-accent='green'] { --monitor-accent: var(--green); }
.monitor-section--empty .monitor-section__count {
  background: var(--canvas);
}
.monitor-section__header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 48px;
  padding: 8px 12px 8px 16px;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: color-mix(in srgb, var(--monitor-accent) 8%, var(--canvas));
  cursor: pointer;
  font-family: var(--ui);
  font-size: 13px;
  color: var(--ink);
  transition: background-color 120ms ease;
  text-align: left;
}
.monitor-section__header::before {
  content: '';
  position: absolute;
  inset: 8px auto 8px 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--monitor-accent);
}
.monitor-section__header:hover {
  background: color-mix(in srgb, var(--monitor-accent) 13%, var(--canvas));
}
.monitor-section__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--txt-3);
  flex-shrink: 0;
}
.monitor-section__heading {
  display: grid;
  min-width: 0;
  gap: 1px;
}
.monitor-section__title {
  font-weight: 600;
}
.monitor-section__meta {
  color: var(--txt-2);
  font-size: 11px;
}
.monitor-section__count {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 24px;
  background: color-mix(in srgb, var(--monitor-accent) 13%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--monitor-accent) 28%, var(--line));
  border-radius: 12px;
  padding: 2px 7px;
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--monitor-accent) 35%, var(--ink));
  text-align: center;
}
.monitor-section__body {
  padding: 8px;
}
.monitor-section__body[hidden] {
  display: none;
}
.monitor-section__list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.monitor-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px;
  border-radius: 8px;
  transition: background-color 120ms ease;
}
.monitor-row:hover {
  background: color-mix(in srgb, var(--monitor-accent) 5%, var(--ghost));
}
.monitor-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: 8px;
  color: color-mix(in srgb, var(--monitor-accent) 35%, var(--ink));
  background: color-mix(in srgb, var(--monitor-accent) 10%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--monitor-accent) 20%, var(--line));
}
.monitor-row__content {
  display: grid;
  min-width: 0;
  gap: 3px;
}
.monitor-row__headline {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  flex-wrap: wrap;
}
.monitor-row__name {
  min-width: 0;
  overflow: hidden;
  color: var(--ink);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-row__sublabel {
  overflow: hidden;
  color: var(--txt-2);
  font-size: 11px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-row__badges {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.monitor-row__badge {
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--monitor-accent) 24%, var(--line));
  border-radius: 9px;
  color: color-mix(in srgb, var(--monitor-accent) 30%, var(--ink));
  background: color-mix(in srgb, var(--monitor-accent) 8%, var(--canvas));
  font-size: 10px;
  line-height: 1.3;
  font-weight: 600;
}
.monitor-row__aside {
  display: grid;
  justify-items: end;
  min-width: 88px;
  gap: 3px;
  text-align: right;
}
.monitor-row__meta {
  color: var(--txt-2);
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
}
.monitor-row__state {
  --monitor-status: var(--txt-2);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--monitor-status);
  font-size: 10px;
  line-height: 1.4;
  font-weight: 700;
}
.monitor-row__state--active {
  --monitor-status: color-mix(in srgb, var(--green) 35%, var(--ink));
}
.monitor-row__state--error {
  --monitor-status: color-mix(in srgb, var(--red) 35%, var(--ink));
}
.monitor-row__state--warn {
  --monitor-status: color-mix(in srgb, var(--amber) 35%, var(--ink));
}
.monitor-row__dot {
  position: relative;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}
.monitor-row__state--active .monitor-row__dot::after {
  content: '';
  position: absolute;
  inset: -4px;
  border: 1px solid currentColor;
  border-radius: 50%;
  animation: monitor-pulse 2s ease-out infinite;
}
.monitor-row__state--error .monitor-row__dot {
  border-radius: 2px;
  transform: rotate(45deg);
}
.monitor-row__state--warn .monitor-row__dot {
  width: 8px;
  height: 8px;
  border: 2px solid currentColor;
  background: transparent;
}
.monitor-empty {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 24px 16px;
  color: var(--txt-2);
  text-align: center;
}
.monitor-empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 4px;
  border-radius: 12px;
  color: color-mix(in srgb, var(--monitor-accent) 30%, var(--ink));
  background: color-mix(in srgb, var(--monitor-accent) 9%, var(--canvas));
}
.monitor-empty__title {
  color: var(--ink);
  font-size: 12px;
  font-weight: 700;
}
.monitor-empty__text {
  max-width: 32ch;
  font-size: 11px;
  line-height: 1.5;
}
@keyframes monitor-pulse {
  from { opacity: 0.55; transform: scale(0.55); }
  to { opacity: 0; transform: scale(1.25); }
}
@container monitor (max-width: 560px) {
  .monitor-summary__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .monitor-sections {
    grid-template-columns: 1fr;
  }
  .monitor-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .monitor-row__aside {
    grid-column: 2;
    grid-template-columns: 1fr auto;
    justify-items: start;
    min-width: 0;
    width: 100%;
    text-align: left;
  }
}
@media (prefers-reduced-motion: reduce) {
  .monitor-row__state--active .monitor-row__dot::after {
    animation: none;
  }
  .monitor-summary__refresh,
  .monitor-section__header,
  .monitor-row {
    transition-duration: 0.01ms;
  }
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

function resolveStatus(row: MonitorRow): MonitorStatus {
  if (row.status) return row.status;
  if (row.error) return 'error';
  if (row.active) return 'active';
  return 'idle';
}

function statusLabel(status: MonitorStatus): string {
  if (status === 'active') return 'Active';
  if (status === 'error') return 'Error';
  if (status === 'warn') return 'Warning';
  return 'Idle';
}

function createRow(row: MonitorRow): HTMLElement {
  const status = resolveStatus(row);
  const badges = h('span', { class: 'monitor-row__badges' });
  for (const badge of row.badges ?? []) {
    badges.appendChild(h('span', { class: 'monitor-row__badge' }, badge));
  }

  const headline = h(
    'span',
    { class: 'monitor-row__headline' },
    h('span', { class: 'monitor-row__name' }, row.name)
  );
  if (badges.childElementCount > 0) headline.appendChild(badges);

  const content = h('span', { class: 'monitor-row__content' }, headline);
  if (row.sublabel) {
    content.appendChild(h('span', { class: 'monitor-row__sublabel' }, row.sublabel));
  }

  return h(
    'li',
    { class: 'monitor-row', 'data-status': status },
    h('span', { class: 'monitor-row__icon' }, iconEl(row.icon ?? 'box', { size: 16 })),
    content,
    h(
      'span',
      { class: 'monitor-row__aside' },
      h('span', { class: 'monitor-row__meta' }, row.meta),
      h(
        'span',
        { class: `monitor-row__state monitor-row__state--${status}` },
        h('span', { class: 'monitor-row__dot', 'aria-hidden': 'true' }),
        statusLabel(status)
      )
    )
  );
}

function createEmptyState(section: MonitorSection): HTMLElement {
  return h(
    'div',
    { class: 'monitor-empty', role: 'status' },
    h('span', { class: 'monitor-empty__icon' }, iconEl('inbox', { size: 18 })),
    h('span', { class: 'monitor-empty__title' }, `No ${section.label.toLocaleLowerCase()} yet`),
    h(
      'span',
      { class: 'monitor-empty__text' },
      section.emptyText ?? `${section.label} will appear here when available.`
    )
  );
}

function createSection(
  section: MonitorSection,
  collapsed: Set<string>,
  onToggle: (id: string) => void,
  bodyId: string
): HTMLElement {
  const isCollapsed = collapsed.has(section.id);
  const sectionClass =
    section.count === 0 ? 'monitor-section monitor-section--empty' : 'monitor-section';

  const headerChildren: (string | HTMLElement)[] = [
    h(
      'span',
      { class: 'monitor-section__toggle', 'aria-hidden': 'true' },
      iconEl(isCollapsed ? 'chevron-right' : 'chevron-down', { size: 15 })
    ),
    h(
      'span',
      { class: 'monitor-section__heading' },
      h('span', { class: 'monitor-section__title' }, section.label),
      section.meta ? h('span', { class: 'monitor-section__meta' }, section.meta) : null
    ),
  ];

  headerChildren.push(h('span', { class: 'monitor-section__count' }, String(section.count)));

  const header = h(
    'button',
    { class: 'monitor-section__header', type: 'button' },
    ...headerChildren
  );
  header.setAttribute('aria-expanded', String(!isCollapsed));
  header.setAttribute('aria-controls', bodyId);
  header.addEventListener('click', () => onToggle(section.id));

  const body = h('div', { class: 'monitor-section__body', id: bodyId });
  if (isCollapsed) body.setAttribute('hidden', '');

  if (section.rows.length === 0) {
    body.appendChild(createEmptyState(section));
  } else {
    const list = h('ul', { class: 'monitor-section__list' });
    for (const row of section.rows) list.appendChild(createRow(row));
    body.appendChild(list);
  }

  return h(
    'section',
    { class: sectionClass, 'data-section': section.id, 'data-accent': section.accent ?? 'neutral' },
    header,
    body
  );
}

function createMetric(label: string, value: string): HTMLElement {
  return h('div', { class: 'monitor-summary__metric' }, h('dt', null, label), h('dd', null, value));
}

function createSummary(sections: MonitorSection[], onRefresh: () => void): HTMLElement {
  const rows = sections.flatMap((section) => section.rows);
  const active = rows.filter((row) => resolveStatus(row) === 'active').length;
  const attention = rows.filter((row) => ['warn', 'error'].includes(resolveStatus(row))).length;
  const tracked = sections.reduce(
    (total, section) => total + (section.id === 'cost' ? 0 : section.count),
    0
  );
  const cost = sections.find((section) => section.id === 'cost')?.meta ?? '—';
  const refresh = h(
    'button',
    { class: 'monitor-summary__refresh', type: 'button', 'aria-label': 'Refresh monitor data' },
    iconEl('refresh-cw', { size: 15 }),
    h('span', null, 'Refresh')
  );
  refresh.addEventListener('click', onRefresh);

  return h(
    'header',
    { class: 'monitor-summary' },
    h(
      'div',
      { class: 'monitor-summary__topline' },
      h('span', { class: 'monitor-summary__mark' }, iconEl('activity', { size: 19 })),
      h(
        'div',
        { class: 'monitor-summary__copy' },
        h('h2', { class: 'monitor-summary__title' }, 'Live monitor'),
        h(
          'p',
          { class: 'monitor-summary__subtitle' },
          'System activity and connections at a glance'
        )
      ),
      refresh
    ),
    h(
      'dl',
      { class: 'monitor-summary__metrics' },
      createMetric('Tracked', String(tracked)),
      createMetric('Active', String(active)),
      createMetric('Attention', String(attention)),
      createMetric('Session cost', cost)
    )
  );
}

function cloneSection(section: MonitorSection): MonitorSection {
  return {
    ...section,
    rows: section.rows.map((row) => ({ ...row, badges: row.badges?.slice() })),
  };
}

let monitorInstance = 0;

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
  readonly #instanceId = ++monitorInstance;

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
    return this.#sections.map(cloneSection);
  }

  set sections(value: MonitorSection[]) {
    this.#sections = Array.isArray(value) ? value.map(cloneSection) : [];
    if (this.isConnected) this.#render();
  }

  #render(): void {
    const summary = createSummary(this.#sections, () => {
      this.dispatchEvent(
        new CustomEvent('slicc-monitor-refresh', {
          bubbles: true,
          composed: true,
        })
      );
    });
    const sections = h('div', { class: 'monitor-sections' });

    for (const section of this.#sections) {
      const safeId = section.id.replace(/[^a-z0-9_-]/gi, '-');
      sections.appendChild(
        createSection(
          section,
          this.#collapsed,
          (id: string) => {
            if (this.#collapsed.has(id)) this.#collapsed.delete(id);
            else this.#collapsed.add(id);
            setCollapsed(this.#collapsed);
            this.#render();
          },
          `monitor-${this.#instanceId}-${safeId}`
        )
      );
    }

    this.replaceChildren();
    append(this, [summary, sections]);
  }
}

define('slicc-monitor', SliccMonitor);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-monitor': SliccMonitor;
  }
}
