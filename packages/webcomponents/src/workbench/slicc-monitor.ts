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
  /** Indent level inside its group — used for the cone → scoop tree. */
  depth?: number;
}

/**
 * A topology group: one named part of the system, its rows, and a status.
 *
 * Rendered as a single summary LINE that expands, not as a card. A healthy
 * group is one line; only groups that need attention open by default. See
 * the component doc for why.
 */
export interface MonitorSection {
  id: string;
  label: string;
  count: number;
  rows: MonitorRow[];
  meta?: string;
  accent?: MonitorAccent;
  emptyText?: string;
  icon?: string;
  /**
   * Group-level health. When omitted it is derived from the rows — the worst
   * row status wins — so a caller that already sets row statuses gets the
   * roll-up for free.
   */
  status?: MonitorStatus;
}

/**
 * A vitals tile: a rate, a ratio, or a headline figure.
 *
 * `series` (a sparkline) and `ratio` (a meter) are mutually exclusive —
 * a rate over time and a share of a limit are different questions and get
 * different marks. Exactly one tile per view should set `hero`.
 */
export interface MonitorVital {
  id: string;
  label: string;
  value: string;
  unit?: string;
  /** Optional comparison line, already formatted (e.g. `▲ 18% vs last hour`). */
  delta?: string;
  /** Small print under the mark — the window, the absolute total, the peak. */
  foot?: string;
  /** The single ≥48px figure the panel leads with. At most one. */
  hero?: boolean;
  /** Time series for a sparkline. Needs at least two points to render. */
  series?: number[];
  /** 0..1 fill for a meter. Use for a share of a limit, never for a rate. */
  ratio?: number;
  accent?: MonitorAccent;
}

/**
 * Something that is degraded, expired, or failing.
 *
 * The attention feed is the panel's reason to exist: a count of problems is
 * a dead end, a list of them with enough detail to act is not.
 */
export interface MonitorAlert {
  id: string;
  title: string;
  detail?: string;
  /** Relative age, already formatted (`12m ago`). */
  age?: string;
  icon?: string;
  severity: 'warn' | 'error';
}

/** One process in the table. Mirrors the `ps` column vocabulary. */
export interface MonitorProcessRow {
  pid: number;
  ppid?: number;
  /** procfs state letter — `R` / `S` / `Z` / `K`. */
  state: string;
  status: string;
  command: string;
  scoop?: string;
  started?: string;
  elapsed?: string;
}

/**
 * The process table.
 *
 * `rows` is LIVE processes only. `terminated` is the session total of
 * everything that has already exited — reported as a number, never as rows.
 */
export interface MonitorProcessTable {
  rows: MonitorProcessRow[];
  terminated: number;
}

/** Everything the panel renders, in one assignment. */
export interface MonitorModel {
  vitals?: MonitorVital[];
  alerts?: MonitorAlert[];
  sections?: MonitorSection[];
  processes?: MonitorProcessTable | null;
  /** Freshness line under the title (`updated 2s ago`). */
  updated?: string;
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
 * Container queries, not viewport queries: the panel is a dock tile whose
 * width comes from the layout, not the window, so a viewport query would
 * leave a half-width tile at four columns.
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
  container: monitor / inline-size;
  --monitor-ok: var(--green);
  --monitor-warn: var(--waffle);
  --monitor-bad: var(--red);
}
.dark slicc-monitor,
[data-theme="dark"] slicc-monitor {
  /*
   * Status hues are re-stepped for the dark surface rather than flipped:
   * --green / --red measure 4.06:1 and 3.14:1 on #161618, both under 4.5:1
   * for the small status text they carry. These sit at ~6-7:1.
   */
  --monitor-ok: #35b45c;
  --monitor-warn: #e0a03a;
  --monitor-bad: #ef6a52;
}
.monitor {
  display: grid;
  gap: 18px;
  padding: 18px;
  box-sizing: border-box;
}

/* header */
.monitor-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.monitor-head__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border-radius: 11px;
  color: var(--accent);
  background: color-mix(in srgb, var(--ctx) 12%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--ctx) 26%, var(--line));
}
.monitor-head__copy {
  flex: 1 1 auto;
  min-width: 0;
}
.monitor-head__title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.monitor-head__sub {
  margin: 1px 0 0;
  font-size: 11px;
  color: var(--txt-2);
}

/* tier 1 — vitals */
.monitor-vitals {
  display: grid;
  grid-template-columns: 1.6fr 1fr 1fr 1fr;
  gap: 12px;
}
.monitor-tile {
  display: grid;
  grid-template-rows: auto auto 1fr auto;
  gap: 4px;
  padding: 14px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--canvas);
}
.monitor-tile--hero {
  grid-template-rows: auto auto auto 1fr auto;
  gap: 2px;
}
.monitor-tile__label {
  font-size: 11px;
  font-weight: 600;
  color: var(--txt-2);
}
.monitor-tile__figure {
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.monitor-tile__value {
  font-size: 26px;
  line-height: 1.15;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.monitor-tile--hero .monitor-tile__value {
  font-size: 48px;
  line-height: 1.05;
  letter-spacing: -0.03em;
}
.monitor-tile__unit {
  font-size: 11px;
  color: var(--txt-2);
}
.monitor-tile--hero .monitor-tile__unit {
  font-size: 14px;
}
.monitor-tile__delta {
  font-size: 11px;
  font-weight: 600;
  color: var(--txt-2);
}
.monitor-tile__plot {
  align-self: center;
  min-width: 0;
  margin: 6px 0 2px;
}
.monitor-tile__plot svg {
  max-width: 100%;
  height: auto;
}
.monitor-tile__foot {
  font-size: 10.5px;
  color: var(--txt-3);
}
.monitor-meter {
  display: block;
  height: 10px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--monitor-hue) 16%, var(--canvas));
  overflow: hidden;
}
.monitor-meter__fill {
  display: block;
  height: 100%;
  border-radius: 5px;
  background: var(--monitor-hue);
}

/* blocks */
.monitor-block {
  display: grid;
  gap: 8px;
}
.monitor-block__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.monitor-block__title {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--txt-2);
}
.monitor-block__hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--txt-3);
}
.monitor-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.monitor-pill--ok {
  color: var(--monitor-ok);
  background: color-mix(in srgb, var(--monitor-ok) 12%, var(--canvas));
}
.monitor-pill--warn {
  color: var(--monitor-warn);
  background: color-mix(in srgb, var(--monitor-warn) 18%, var(--canvas));
}
.monitor-pill--error {
  color: var(--monitor-bad);
  background: color-mix(in srgb, var(--monitor-bad) 12%, var(--canvas));
}

/*
 * Status glyphs. The shape varies with the state as well as the hue —
 * --amber measures 2.09:1 on the light surface, so color alone would not
 * clear contrast, and every state also carries a word.
 */
.monitor-glyph {
  display: inline-flex;
  align-items: center;
}
.monitor-glyph--active { color: var(--monitor-ok); }
.monitor-glyph--warn { color: var(--monitor-warn); }
.monitor-glyph--error { color: var(--monitor-bad); }
.monitor-glyph--idle { color: var(--txt-3); }

/* tier 2 — attention */
.monitor-alerts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.monitor-alert {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: 12px;
  background: var(--canvas);
}
.monitor-alert[data-severity="warn"] { border-left-color: var(--monitor-warn); }
.monitor-alert[data-severity="error"] { border-left-color: var(--monitor-bad); }
.monitor-alert__icon { display: inline-flex; }
.monitor-alert__copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.monitor-alert__title {
  font-size: 12.5px;
  font-weight: 650;
}
.monitor-alert__detail {
  font-size: 11px;
  color: var(--txt-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-alert__age {
  font-size: 11px;
  color: var(--txt-3);
  font-variant-numeric: tabular-nums;
}
.monitor-clear {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--monitor-ok) 28%, var(--line));
  border-radius: 12px;
  background: color-mix(in srgb, var(--monitor-ok) 8%, var(--canvas));
}
.monitor-clear__title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--monitor-ok);
}
.monitor-clear__text {
  font-size: 11.5px;
  color: var(--txt-2);
}

/* tier 3a — topology */
.monitor-groups {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--canvas);
  overflow: hidden;
}
.monitor-group + .monitor-group {
  border-top: 1px solid var(--line);
}
.monitor-row {
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}
.monitor-row:hover {
  background: color-mix(in srgb, var(--ink) 3%, var(--canvas));
}
.monitor-row__chev,
.monitor-row__icon {
  display: inline-flex;
  color: var(--txt-2);
}
.monitor-row__name {
  font-size: 12.5px;
  font-weight: 650;
}
.monitor-row__summary {
  font-size: 11.5px;
  color: var(--txt-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-row__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
}
.monitor-children {
  list-style: none;
  margin: 0;
  padding: 0 0 6px;
}
.monitor-child {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 5px 12px;
}
.monitor-child__copy {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.monitor-child__headline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.monitor-child__name {
  font-size: 12px;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-child__sublabel {
  font-size: 11px;
  color: var(--txt-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.monitor-child__meta {
  font-size: 11px;
  color: var(--txt-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.monitor-badge {
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 600;
  color: var(--txt-2);
  background: var(--ghost);
  white-space: nowrap;
}
.monitor-empty {
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 18px 16px;
  color: var(--txt-2);
  text-align: center;
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

/* tier 3b — the process table */
.monitor-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.monitor-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  color: var(--ink);
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 9px;
}
.monitor-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--txt-2);
  white-space: nowrap;
}
.monitor-tablewrap {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--canvas);
  overflow: auto;
  max-height: 420px;
}
.monitor-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.monitor-th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 10px;
  text-align: left;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--txt-2);
  background: var(--canvas);
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  white-space: nowrap;
}
.monitor-th:hover { color: var(--ink); }
.monitor-th__label { margin-right: 4px; }
.monitor-tr:hover {
  background: color-mix(in srgb, var(--ink) 3%, var(--canvas));
}
.monitor-td {
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, var(--canvas));
  white-space: nowrap;
}
.monitor-td--pid,
.monitor-td--ppid,
.monitor-td--started,
.monitor-td--elapsed {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.monitor-td--command {
  width: 100%;
  max-width: 0;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
}
.monitor-statcell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.monitor-stat-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--txt-2);
  background: var(--ghost);
}
.monitor-stat-tag--R {
  color: var(--monitor-ok);
  background: color-mix(in srgb, var(--monitor-ok) 13%, var(--canvas));
}
.monitor-stat-tag--S {
  color: var(--cyan);
  background: color-mix(in srgb, var(--cyan) 15%, var(--canvas));
}
.monitor-stat-tag--K {
  color: var(--monitor-bad);
  background: color-mix(in srgb, var(--monitor-bad) 12%, var(--canvas));
}
.monitor-stat-word {
  font-size: 11px;
  color: var(--txt-2);
}
.monitor-empty-cell {
  padding: 18px 12px;
  color: var(--txt-2);
  text-align: center;
  white-space: normal;
}

/* buttons */
.monitor-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink);
  background: var(--canvas);
  border: 1px solid var(--line);
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.12s ease;
}
.monitor-btn:hover { border-color: var(--txt-3); }

@container monitor (max-width: 940px) {
  .monitor-vitals { grid-template-columns: 1fr 1fr; }
  .monitor-tile--hero,
  .monitor-vitals > :last-child { grid-column: span 2; }
}
@container monitor (max-width: 560px) {
  .monitor-vitals { grid-template-columns: 1fr; }
  .monitor-tile--hero,
  .monitor-vitals > :last-child { grid-column: auto; }
  .monitor-row { grid-template-columns: auto auto minmax(0, 1fr); row-gap: 2px; }
  .monitor-row__summary,
  .monitor-row__state { grid-column: 3; justify-self: start; }
}
@media (prefers-reduced-motion: reduce) {
  .monitor-row,
  .monitor-btn { transition-duration: 0.01ms; }
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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<MonitorStatus, number> = { error: 3, warn: 2, active: 1, idle: 0 };

const STATUS_GLYPH: Record<MonitorStatus, string> = {
  active: 'circle-check',
  warn: 'triangle-alert',
  error: 'octagon-x',
  idle: 'circle',
};

const STATUS_LABEL: Record<MonitorStatus, string> = {
  active: 'Healthy',
  warn: 'Attention',
  error: 'Failing',
  idle: 'Idle',
};

function resolveStatus(row: MonitorRow): MonitorStatus {
  if (row.status) return row.status;
  if (row.error) return 'error';
  if (row.active) return 'active';
  return 'idle';
}

/** Group health: explicit if set, otherwise the worst row wins. */
function sectionStatus(section: MonitorSection): MonitorStatus {
  if (section.status) return section.status;
  let worst: MonitorStatus = 'idle';
  for (const row of section.rows) {
    const status = resolveStatus(row);
    if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  }
  return worst;
}

function statusGlyph(status: MonitorStatus): HTMLElement {
  return h(
    'span',
    { class: `monitor-glyph monitor-glyph--${status}` },
    iconEl(STATUS_GLYPH[status], { size: 14 })
  );
}

const ACCENT_HUE: Record<MonitorAccent, string> = {
  rose: 'var(--rose)',
  cyan: 'var(--cyan)',
  violet: 'var(--violet)',
  amber: 'var(--amber)',
  waffle: 'var(--waffle)',
  green: 'var(--green)',
};

function accentHue(accent: MonitorAccent | undefined): string {
  return accent ? ACCENT_HUE[accent] : 'var(--ctx)';
}

// ---------------------------------------------------------------------------
// Tier 1 — vitals
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Project a series into `x`/`y` pairs inside a `w × h` box with a 3px inset. */
function projectSeries(series: number[], w: number, h: number): { x: number; y: number }[] {
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const pad = 3;
  return series.map((v, i) => ({
    x: pad + (i / (series.length - 1)) * (w - pad * 2),
    y: h - pad - ((v - min) / span) * (h - pad * 2),
  }));
}

/**
 * A sparkline: a 2px line, a 10%-opacity area wash, and an end marker
 * carrying a 2px surface ring so it stays legible where it crosses the line.
 * No axes, no gridlines, no per-point labels.
 */
function sparkline(series: number[], hue: string, w: number, h: number): SVGElement {
  const pts = projectSeries(series, w, h);
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const svg = svgEl('svg', {
    width: w,
    height: h,
    viewBox: `0 0 ${w} ${h}`,
    'aria-hidden': 'true',
  });
  svg.append(
    svgEl('polygon', {
      points: `${line} ${w - 3},${h} 3,${h}`,
      fill: hue,
      'fill-opacity': '0.1',
    }),
    svgEl('polyline', {
      points: line,
      fill: 'none',
      stroke: hue,
      'stroke-width': '2',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
    svgEl('circle', {
      cx: last.x,
      cy: last.y,
      r: '4',
      fill: hue,
      stroke: 'var(--canvas)',
      'stroke-width': '2',
    })
  );
  return svg;
}

/** The mark for a tile: a sparkline for a rate, a meter for a share. */
function createVitalPlot(vital: MonitorVital): HTMLElement | null {
  const hue = accentHue(vital.accent);
  if (vital.series && vital.series.length > 1) {
    const size = vital.hero ? { w: 300, h: 56 } : { w: 132, h: 34 };
    return h('div', { class: 'monitor-tile__plot' }, sparkline(vital.series, hue, size.w, size.h));
  }
  if (typeof vital.ratio === 'number') {
    const pct = Math.max(0, Math.min(1, vital.ratio)) * 100;
    return h(
      'div',
      { class: 'monitor-tile__plot' },
      h(
        'span',
        { class: 'monitor-meter', style: `--monitor-hue:${hue}` },
        h('span', { class: 'monitor-meter__fill', style: `width:${pct.toFixed(1)}%` })
      )
    );
  }
  return null;
}

function createVitalTile(vital: MonitorVital): HTMLElement {
  const tile = h('section', {
    class: `monitor-tile${vital.hero ? ' monitor-tile--hero' : ''}`,
    'data-vital': vital.id,
  });
  append(tile, [
    h('span', { class: 'monitor-tile__label' }, vital.label),
    h(
      'div',
      { class: 'monitor-tile__figure' },
      h('span', { class: 'monitor-tile__value' }, vital.value),
      vital.unit ? h('span', { class: 'monitor-tile__unit' }, vital.unit) : null
    ),
    vital.delta ? h('span', { class: 'monitor-tile__delta' }, vital.delta) : null,
    createVitalPlot(vital),
    vital.foot ? h('span', { class: 'monitor-tile__foot' }, vital.foot) : null,
  ]);
  return tile;
}

function createVitals(vitals: MonitorVital[]): HTMLElement {
  return h('div', { class: 'monitor-vitals' }, ...vitals.map(createVitalTile));
}

// ---------------------------------------------------------------------------
// Tier 2 — attention
// ---------------------------------------------------------------------------

function createAlert(alert: MonitorAlert): HTMLElement {
  return h(
    'li',
    { class: 'monitor-alert', 'data-severity': alert.severity, 'data-alert': alert.id },
    h(
      'span',
      { class: `monitor-alert__icon monitor-glyph--${alert.severity}` },
      iconEl(alert.icon ?? STATUS_GLYPH[alert.severity === 'error' ? 'error' : 'warn'], {
        size: 16,
      })
    ),
    h(
      'span',
      { class: 'monitor-alert__copy' },
      h('span', { class: 'monitor-alert__title' }, alert.title),
      alert.detail ? h('span', { class: 'monitor-alert__detail' }, alert.detail) : null
    ),
    alert.age ? h('span', { class: 'monitor-alert__age' }, alert.age) : null
  );
}

function createAllClear(): HTMLElement {
  return h(
    'div',
    { class: 'monitor-clear', role: 'status' },
    statusGlyph('active'),
    h('span', { class: 'monitor-clear__title' }, 'All clear'),
    h('span', { class: 'monitor-clear__text' }, 'Nothing is stalled, expired, or failing.')
  );
}

function createAttention(alerts: MonitorAlert[]): HTMLElement {
  const severity = alerts.some((a) => a.severity === 'error')
    ? 'error'
    : alerts.length > 0
      ? 'warn'
      : 'ok';
  return h(
    'section',
    { class: 'monitor-block', 'data-block': 'attention' },
    h(
      'div',
      { class: 'monitor-block__head' },
      h('h3', { class: 'monitor-block__title' }, 'Needs attention'),
      h('span', { class: `monitor-pill monitor-pill--${severity}` }, String(alerts.length))
    ),
    alerts.length === 0
      ? createAllClear()
      : h('ul', { class: 'monitor-alerts' }, ...alerts.map(createAlert))
  );
}

// ---------------------------------------------------------------------------
// Tier 3a — topology
// ---------------------------------------------------------------------------

function createChild(row: MonitorRow): HTMLElement {
  const status = resolveStatus(row);
  const headline = h(
    'span',
    { class: 'monitor-child__headline' },
    h('span', { class: 'monitor-child__name' }, row.name)
  );
  for (const badge of row.badges ?? []) {
    headline.appendChild(h('span', { class: 'monitor-badge' }, badge));
  }
  const copy = h('span', { class: 'monitor-child__copy' }, headline);
  if (row.sublabel) {
    copy.appendChild(h('span', { class: 'monitor-child__sublabel' }, row.sublabel));
  }
  return h(
    'li',
    {
      class: 'monitor-child',
      'data-status': status,
      style: `padding-left:${28 + (row.depth ?? 0) * 18}px`,
    },
    statusGlyph(status),
    copy,
    h('span', { class: 'monitor-child__meta' }, row.meta)
  );
}

function createGroupEmpty(section: MonitorSection): HTMLElement {
  return h(
    'div',
    { class: 'monitor-empty', role: 'status' },
    h('span', { class: 'monitor-empty__title' }, `No ${section.label.toLocaleLowerCase()} yet`),
    h(
      'span',
      { class: 'monitor-empty__text' },
      section.emptyText ?? `${section.label} will appear here when available.`
    )
  );
}

/**
 * One topology group as a summary LINE that expands.
 *
 * Eight of the panel's groups are inventory — tray, followers, mounts, MCP,
 * accounts, automations — and inventory that is fine needs one line, not a
 * card. Groups needing attention open by default; the rest stay closed
 * unless the reader (or their saved collapse state) says otherwise.
 */
function createGroup(
  section: MonitorSection,
  collapsed: Set<string>,
  expanded: Set<string>,
  onToggle: (id: string, wasOpen: boolean) => void,
  bodyId: string
): HTMLElement {
  const status = sectionStatus(section);
  const attention = status === 'warn' || status === 'error';
  const open = expanded.has(section.id)
    ? true
    : collapsed.has(section.id)
      ? false
      : attention && section.rows.length > 0;

  const list = h('ul', { class: 'monitor-children', id: bodyId });
  if (section.rows.length === 0) list.replaceChildren(createGroupEmpty(section));
  else list.append(...section.rows.map(createChild));
  if (!open) list.setAttribute('hidden', '');

  const header = h(
    'button',
    { class: 'monitor-row', type: 'button' },
    h(
      'span',
      { class: 'monitor-row__chev', 'aria-hidden': 'true' },
      iconEl(open ? 'chevron-down' : 'chevron-right', { size: 15 })
    ),
    h('span', { class: 'monitor-row__icon' }, iconEl(section.icon ?? 'box', { size: 16 })),
    h('span', { class: 'monitor-row__name' }, section.label),
    h('span', { class: 'monitor-row__summary' }, section.meta ?? `${section.count}`),
    h(
      'span',
      { class: `monitor-row__state monitor-glyph--${status}` },
      statusGlyph(status),
      STATUS_LABEL[status]
    )
  );
  header.setAttribute('aria-expanded', String(open));
  header.setAttribute('aria-controls', bodyId);
  header.addEventListener('click', () => onToggle(section.id, open));

  return h(
    'div',
    {
      class: 'monitor-group',
      'data-section': section.id,
      'data-status': status,
      'data-accent': section.accent ?? 'neutral',
    },
    header,
    list
  );
}

// ---------------------------------------------------------------------------
// Tier 3b — the process table
// ---------------------------------------------------------------------------

const PROCESS_COLUMNS = ['pid', 'ppid', 'state', 'started', 'elapsed', 'scoop', 'command'] as const;
type ProcessColumn = (typeof PROCESS_COLUMNS)[number];

const LIVE_STATES = new Set(['R', 'S']);

function createProcessCell(row: MonitorProcessRow, column: ProcessColumn): HTMLElement {
  if (column === 'state') {
    return h(
      'td',
      { class: 'monitor-td monitor-td--state' },
      h(
        'span',
        { class: 'monitor-statcell' },
        h('span', { class: `monitor-stat-tag monitor-stat-tag--${row.state}` }, row.state),
        h('span', { class: 'monitor-stat-word' }, row.status)
      )
    );
  }
  const value = row[column];
  return h(
    'td',
    { class: `monitor-td monitor-td--${column}` },
    value == null ? '—' : String(value)
  );
}

function createProcessRow(row: MonitorProcessRow): HTMLElement {
  return h(
    'tr',
    {
      class: 'monitor-tr',
      'data-pid': String(row.pid),
      'data-live': String(LIVE_STATES.has(row.state)),
    },
    ...PROCESS_COLUMNS.map((column) => createProcessCell(row, column))
  );
}

function sortProcesses(
  rows: MonitorProcessRow[],
  column: ProcessColumn,
  descending: boolean
): MonitorProcessRow[] {
  return [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''));
    return descending ? -cmp : cmp;
  });
}

interface ProcessViewState {
  sort: ProcessColumn;
  descending: boolean;
  query: string;
}

function createProcessHeader(state: ProcessViewState, redraw: () => void): HTMLElement {
  const cells = PROCESS_COLUMNS.map((column) => {
    const active = state.sort === column;
    const th = h(
      'th',
      { class: `monitor-th monitor-td--${column}`, scope: 'col' },
      h('span', { class: 'monitor-th__label' }, column.toUpperCase()),
      active ? iconEl(state.descending ? 'chevron-down' : 'chevron-up', { size: 12 }) : null
    );
    th.setAttribute('aria-sort', active ? (state.descending ? 'descending' : 'ascending') : 'none');
    th.addEventListener('click', () => {
      state.descending = state.sort === column ? !state.descending : false;
      state.sort = column;
      redraw();
    });
    return th;
  });
  return h('tr', null, ...cells);
}

function matchesQuery(row: MonitorProcessRow, query: string): boolean {
  if (!query) return true;
  return (
    row.command.toLowerCase().includes(query) ||
    (row.scoop ?? '').toLowerCase().includes(query) ||
    String(row.pid).includes(query)
  );
}

/**
 * The process table.
 *
 * The one part of the panel that is genuinely a table and should not share
 * the topology vocabulary. Sortable on every column, filterable, and the
 * exited count rides in the header rather than becoming thousands of rows —
 * the same call `ps` makes by default.
 */
function createProcesses(table: MonitorProcessTable): HTMLElement {
  const state: ProcessViewState = { sort: 'pid', descending: false, query: '' };
  const search = h('input', {
    class: 'monitor-input',
    type: 'search',
    'aria-label': 'Filter processes',
    placeholder: 'Filter command, scoop, or pid…',
  }) as HTMLInputElement;
  const thead = h('thead');
  const tbody = h('tbody');
  const hint = h('span', { class: 'monitor-block__hint' });

  const redraw = (): void => {
    const rows = sortProcesses(table.rows, state.sort, state.descending).filter((row) =>
      matchesQuery(row, state.query)
    );
    thead.replaceChildren(createProcessHeader(state, redraw));
    if (rows.length === 0) {
      // A bare header over nothing reads as a broken table. Say which of the
      // two empty states this is — nothing running, or nothing matching.
      const cell = h('td', {
        class: 'monitor-td monitor-empty-cell',
        colspan: PROCESS_COLUMNS.length,
      });
      cell.textContent = state.query
        ? `No live process matches “${state.query}”.`
        : 'No processes running.';
      tbody.replaceChildren(h('tr', { class: 'monitor-tr' }, cell));
    } else {
      tbody.replaceChildren(...rows.map(createProcessRow));
    }
    const exited =
      table.terminated > 0 ? ` · ${table.terminated.toLocaleString()} exited this session` : '';
    hint.replaceChildren(document.createTextNode(`${table.rows.length} live${exited}`));
  };

  search.addEventListener('input', () => {
    state.query = search.value.trim().toLowerCase();
    redraw();
  });
  redraw();

  return h(
    'section',
    { class: 'monitor-block', 'data-block': 'processes' },
    h(
      'div',
      { class: 'monitor-block__head' },
      h('h3', { class: 'monitor-block__title' }, 'Processes'),
      hint
    ),
    h('div', { class: 'monitor-toolbar' }, search),
    h('div', { class: 'monitor-tablewrap' }, h('table', { class: 'monitor-table' }, thead, tbody))
  );
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

function cloneSection(section: MonitorSection): MonitorSection {
  return {
    ...section,
    rows: section.rows.map((row) => ({ ...row, badges: row.badges?.slice() })),
  };
}

let monitorInstance = 0;

/**
 * `<slicc-monitor>` — the workbench monitor panel.
 *
 * Three tiers, deliberately in three different visual vocabularies, because
 * they answer three different questions:
 *
 *  1. **Vitals** — rates and ratios over time (hero figure, stat tiles with
 *     sparklines, a meter). The only tier with a time axis, and the only
 *     honest answer to "how hard is this thing working".
 *  2. **Attention** — what is degraded, newest first. A count of problems is
 *     a dead end; this is the list it should have expanded into. Healthy
 *     state is a single "All clear" line.
 *  3. **Body** — topology (small, stable, named things; healthy groups
 *     collapse to one line) and a sortable, filterable process table. These
 *     are not the same shape and do not share chrome.
 *
 * Status never rides on hue alone: every state carries a shape-varied glyph
 * AND a word, because `--amber` measures 2.09:1 on the light surface.
 *
 * Light DOM (no shadow root): the host renders into itself so the host app
 * can style and slot content. The scoped stylesheet is injected once into
 * the host document.
 *
 * Collapse state persists in localStorage (`slicc_monitor_collapsed`).
 *
 * @fires slicc-monitor-refresh - the re-sync button was clicked
 */
export class SliccMonitor extends HTMLElement {
  #model: MonitorModel = {};
  #collapsed = new Set<string>();
  /** Groups the reader opened this session, overriding the auto-collapse. */
  #expanded = new Set<string>();
  #initialized = false;
  readonly #instanceId = ++monitorInstance;

  connectedCallback(): void {
    ensureMonitorStyle(this.ownerDocument);
    if (!this.#initialized) {
      this.#collapsed = getCollapsed();
      this.#initialized = true;
    }
    this.#render();
  }

  /** The full panel model (returns a copy). */
  get model(): MonitorModel {
    return {
      ...this.#model,
      vitals: this.#model.vitals?.map((v) => ({ ...v, series: v.series?.slice() })),
      alerts: this.#model.alerts?.map((a) => ({ ...a })),
      sections: this.#model.sections?.map(cloneSection),
      processes: this.#model.processes
        ? { ...this.#model.processes, rows: this.#model.processes.rows.map((r) => ({ ...r })) }
        : this.#model.processes,
    };
  }

  set model(value: MonitorModel) {
    this.#model = value ?? {};
    if (this.isConnected) this.#render();
  }

  /** The topology groups (returns a copy). */
  get sections(): MonitorSection[] {
    return (this.#model.sections ?? []).map(cloneSection);
  }

  set sections(value: MonitorSection[]) {
    this.#model = {
      ...this.#model,
      sections: Array.isArray(value) ? value.map(cloneSection) : [],
    };
    if (this.isConnected) this.#render();
  }

  #createHeader(): HTMLElement {
    const refresh = h(
      'button',
      { class: 'monitor-btn', type: 'button', 'aria-label': 'Re-sync monitor data' },
      iconEl('refresh-cw', { size: 14 }),
      h('span', null, 'Re-sync')
    );
    refresh.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('slicc-monitor-refresh', { bubbles: true, composed: true })
      );
    });
    return h(
      'header',
      { class: 'monitor-head' },
      h('span', { class: 'monitor-head__mark' }, iconEl('activity', { size: 18 })),
      h(
        'div',
        { class: 'monitor-head__copy' },
        h('h2', { class: 'monitor-head__title' }, 'Live monitor'),
        h('p', { class: 'monitor-head__sub' }, this.#model.updated ?? 'Streaming')
      ),
      refresh
    );
  }

  #createTopology(sections: MonitorSection[]): HTMLElement {
    const groups = h('div', { class: 'monitor-groups' });
    for (const section of sections) {
      const safeId = section.id.replace(/[^a-z0-9_-]/gi, '-');
      groups.appendChild(
        createGroup(
          section,
          this.#collapsed,
          this.#expanded,
          (id: string, wasOpen: boolean) => this.#toggle(id, wasOpen),
          `monitor-${this.#instanceId}-${safeId}`
        )
      );
    }
    return h(
      'section',
      { class: 'monitor-block', 'data-block': 'topology' },
      h(
        'div',
        { class: 'monitor-block__head' },
        h('h3', { class: 'monitor-block__title' }, 'Topology'),
        h('span', { class: 'monitor-block__hint' }, 'healthy groups stay collapsed')
      ),
      groups
    );
  }

  /**
   * Toggle a group, keyed off what the reader can actually SEE rather than
   * off set membership — a degraded group opens automatically without being
   * in either set, so membership alone would make the first click on it a
   * no-op that re-opened what the reader just tried to shut.
   *
   * The two sets are not redundant: `#collapsed` persists an explicit "keep
   * this shut" across sessions, while `#expanded` holds a this-session "keep
   * this open" that has to outrank the automatic collapse a healthy group
   * would otherwise get on the next 5s re-render.
   */
  #toggle(id: string, wasOpen: boolean): void {
    if (wasOpen) {
      this.#expanded.delete(id);
      this.#collapsed.add(id);
    } else {
      this.#collapsed.delete(id);
      this.#expanded.add(id);
    }
    setCollapsed(this.#collapsed);
    this.#render();
  }

  #render(): void {
    const { vitals = [], alerts, sections = [], processes } = this.#model;
    const panel = h('div', { class: 'monitor' });
    append(panel, [
      this.#createHeader(),
      vitals.length > 0 ? createVitals(vitals) : null,
      alerts ? createAttention(alerts) : null,
      sections.length > 0 ? this.#createTopology(sections) : null,
      processes ? createProcesses(processes) : null,
    ]);
    this.replaceChildren(panel);
  }
}

define('slicc-monitor', SliccMonitor);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-monitor': SliccMonitor;
  }
}
