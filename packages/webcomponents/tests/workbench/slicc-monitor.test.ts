import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import {
  type MonitorModel,
  type MonitorSection,
  type MonitorSeries,
  SliccMonitor,
} from '../../src/workbench/slicc-monitor.js';

/** A one-hour window, the span the live panel plots into. */
const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Values at a fixed cadence, ending at `NOW` — the live buffer's shape. */
function evenSeries(values: number[], stepMs = 5_000, windowMs = HOUR_MS): MonitorSeries {
  const last = values.length - 1;
  return {
    points: values.map((value, i) => ({ at: NOW - (last - i) * stepMs, value })),
    windowMs,
  };
}

/** Values at explicit ages (ms before `NOW`), oldest first. */
function agedSeries(pairs: [ageMs: number, value: number][], windowMs = HOUR_MS): MonitorSeries {
  return { points: pairs.map(([age, value]) => ({ at: NOW - age, value })), windowMs };
}

const BURN = [0.9, 1.1, 0.8, 0.6, 0.7, 1.2, 1.6, 1.5, 1.1, 0.9, 1.0, 1.4];

function polylinePoints(svg: Element): { x: number; y: number }[] {
  return (svg.querySelector('polyline')?.getAttribute('points') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
}

function mount(model?: MonitorModel): SliccMonitor {
  const el = document.createElement('slicc-monitor') as SliccMonitor;
  if (model) el.model = model;
  document.body.appendChild(el);
  return el;
}

function mountSections(sections: MonitorSection[]): SliccMonitor {
  return mount({ sections });
}

const SAMPLE_SECTIONS: MonitorSection[] = [
  {
    id: 'scoops',
    label: 'Scoops',
    count: 2,
    meta: '2 · 1 working',
    accent: 'violet',
    icon: 'bot',
    status: 'active',
    rows: [
      {
        name: 'sliccy (cone)',
        meta: 'working',
        active: true,
        icon: 'bot',
        sublabel: 'Cone · primary workspace agent',
        badges: ['browser', 'shell'],
      },
      { name: 'researcher', meta: 'idle', depth: 1 },
    ],
  },
  {
    id: 'automations',
    label: 'Automations',
    count: 1,
    meta: '0 webhooks · 1 cron task',
    rows: [{ name: 'daily-backup', meta: '0 3 * * *', active: true }],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    count: 0,
    rows: [],
    emptyText: 'Connect a webhook to receive external events.',
  },
];

describe('slicc-monitor', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-monitor')).toBe(SliccMonitor);
  });

  it('renders into light DOM (no shadow root)', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('.monitor')).not.toBeNull();
  });

  it('renders nothing but the header for an empty model', () => {
    const el = mount({});
    expect(el.querySelector('.monitor-head')).not.toBeNull();
    expect(el.querySelector('.monitor-vitals')).toBeNull();
    expect(el.querySelector('[data-block="attention"]')).toBeNull();
    expect(el.querySelector('[data-block="topology"]')).toBeNull();
    expect(el.querySelector('[data-block="processes"]')).toBeNull();
  });
});

describe('slicc-monitor — vitals', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('renders a tile per vital, with value and unit', () => {
    const el = mount({
      vitals: [
        { id: 'burn', label: 'Burn rate', value: '$1.40', unit: '/hour', hero: true },
        { id: 'load', label: 'Agent load', value: '2', unit: 'of 6 working' },
      ],
    });
    const tiles = el.querySelectorAll('.monitor-tile');
    expect(tiles).toHaveLength(2);
    expect(tiles[0].querySelector('.monitor-tile__value')?.textContent).toBe('$1.40');
    expect(tiles[0].querySelector('.monitor-tile__unit')?.textContent).toBe('/hour');
  });

  it('marks the hero tile so it gets the large figure', () => {
    const el = mount({
      vitals: [
        { id: 'burn', label: 'Burn', value: '$1.40', hero: true },
        { id: 'load', label: 'Load', value: '2' },
      ],
    });
    const hero = el.querySelector('.monitor-tile--hero') as HTMLElement;
    expect(hero.dataset.vital).toBe('burn');
    const heroSize = getComputedStyle(hero.querySelector('.monitor-tile__value')!).fontSize;
    const plainSize = getComputedStyle(
      el.querySelector('.monitor-tile:not(.monitor-tile--hero) .monitor-tile__value')!
    ).fontSize;
    expect(Number.parseFloat(heroSize)).toBeGreaterThan(Number.parseFloat(plainSize));
    expect(Number.parseFloat(heroSize)).toBeGreaterThanOrEqual(48);
  });

  it('plots a sparkline for a series', () => {
    const el = mount({
      vitals: [{ id: 'burn', label: 'Burn', value: '$1.40', series: evenSeries([1, 2, 1.5, 3]) }],
    });
    const svg = el.querySelector('.monitor-tile__plot svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('polyline')).not.toBeNull();
    // The end marker carries a surface ring so it stays legible over the line.
    expect(svg?.querySelector('circle')?.getAttribute('stroke')).toBe('var(--canvas)');
  });

  it('plots no sparkline below two points — one point is not a trend', () => {
    const el = mount({
      vitals: [{ id: 'burn', label: 'Burn', value: '$1.40', series: evenSeries([1]) }],
    });
    expect(el.querySelector('.monitor-tile__plot')).toBeNull();
  });

  it('renders a meter for a ratio, clamped to 0..1', () => {
    const el = mount({
      vitals: [
        { id: 'a', label: 'A', value: '61', ratio: 0.61 },
        { id: 'b', label: 'B', value: '200', ratio: 2 },
        { id: 'c', label: 'C', value: '-5', ratio: -0.5 },
      ],
    });
    const fills = el.querySelectorAll<HTMLElement>('.monitor-meter__fill');
    expect(fills[0].style.width).toBe('61%');
    expect(fills[1].style.width).toBe('100%');
    expect(fills[2].style.width).toBe('0%');
  });

  it("draws one dot per marker, in the marker's own color", () => {
    const el = mount({
      vitals: [
        {
          id: 'context',
          label: 'Context fill',
          value: '70',
          ratio: 0.7,
          markers: [
            { id: 'cone', ratio: 0.7, color: '#b07823', label: 'sliccy (cone) — 70% full' },
            { id: 'review', ratio: 0.2, color: '#3b82f6', label: 'review — 20% full' },
          ],
        },
      ],
    });
    const marks = el.querySelectorAll<HTMLElement>('.monitor-meter__mark');
    expect(marks).toHaveLength(2);
    // Lowest first, so the peak dot paints ON TOP of a crowded neighbour —
    // it is the reading the tile's own figure is already reporting.
    expect([...marks].map((m) => m.dataset.mark)).toEqual(['review', 'cone']);
    expect(marks[0].style.left).toBe('20%');
    expect(marks[1].style.left).toBe('70%');
    expect(getComputedStyle(marks[1]).backgroundColor).toBe('rgb(176, 120, 35)');
    expect(marks[1].title).toBe('sliccy (cone) — 70% full');
  });

  it('clamps a marker to the track and keeps the end dots over the bar', () => {
    const el = mount({
      vitals: [
        {
          id: 'context',
          label: 'Context fill',
          value: '100',
          ratio: 1,
          markers: [
            { id: 'over', ratio: 2, color: '#ef4444' },
            { id: 'under', ratio: -0.5, color: '#06b6d4' },
          ],
        },
      ],
    });
    const marks = el.querySelectorAll<HTMLElement>('.monitor-meter__mark');
    expect(marks[0].style.left).toBe('0%');
    expect(marks[1].style.left).toBe('100%');
    // The rail is inset by a radius at each end, so neither dot hangs off the
    // track it is supposed to be marking.
    const track = el.querySelector('.monitor-meter__track') as HTMLElement;
    const bar = track.getBoundingClientRect();
    for (const mark of marks) {
      const box = mark.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(bar.left - 0.5);
      expect(box.right).toBeLessThanOrEqual(bar.right + 0.5);
    }
  });

  it('draws no marker rail when a meter has no markers to place', () => {
    const el = mount({ vitals: [{ id: 'a', label: 'A', value: '61', ratio: 0.61, markers: [] }] });
    expect(el.querySelector('.monitor-meter')).not.toBeNull();
    expect(el.querySelector('.monitor-meter__marks')).toBeNull();
  });

  it('prefers the sparkline when a vital carries both a series and a ratio', () => {
    const el = mount({
      vitals: [{ id: 'a', label: 'A', value: '1', series: evenSeries([1, 2]), ratio: 0.5 }],
    });
    expect(el.querySelector('.monitor-tile__plot svg')).not.toBeNull();
    expect(el.querySelector('.monitor-meter')).toBeNull();
  });

  it("draws the sparkline at the tile's full content width, not a fixed 300px", async () => {
    // The panel is wider than the old hard-coded 300px hero plot, so a chart
    // that ignores its box leaves a dead strip exactly where "now" lives.
    const el = mount({
      vitals: [{ id: 'burn', label: 'Burn', value: '$1.40', hero: true, series: evenSeries(BURN) }],
    });
    const plot = el.querySelector('.monitor-tile__plot') as HTMLElement;
    expect(plot.clientWidth).toBeGreaterThan(300);
    await vi.waitFor(() => {
      const svg = plot.querySelector('svg') as SVGElement;
      expect(svg.getBoundingClientRect().width).toBeCloseTo(plot.clientWidth, 0);
    });
  });

  it('redraws at the new width when the tile resizes', async () => {
    const host = document.createElement('div');
    host.style.width = '900px';
    document.body.appendChild(host);
    const el = document.createElement('slicc-monitor') as SliccMonitor;
    el.model = {
      vitals: [{ id: 'burn', label: 'Burn', value: '$1.40', hero: true, series: evenSeries(BURN) }],
    };
    host.appendChild(el);
    const plot = el.querySelector('.monitor-tile__plot') as HTMLElement;
    await vi.waitFor(() => {
      expect(plot.querySelector('svg')?.getBoundingClientRect().width).toBeCloseTo(
        plot.clientWidth,
        0
      );
    });
    host.style.width = '480px';
    await vi.waitFor(() => {
      expect(plot.querySelector('svg')?.getBoundingClientRect().width).toBeCloseTo(
        plot.clientWidth,
        0
      );
    });
    host.remove();
  });

  it('lands the newest sample on the right edge, with line, wash and marker agreeing', () => {
    const el = mount({
      vitals: [{ id: 'burn', label: 'Burn', value: '$1.40', series: evenSeries([1, 2, 1.5, 3]) }],
    });
    const svg = el.querySelector('.monitor-tile__plot svg') as SVGElement;
    const width = Number(svg.getAttribute('width'));
    const pts = polylinePoints(svg);
    const marker = svg.querySelector('circle') as SVGElement;
    const strokeHalf = Number(marker.getAttribute('stroke-width')) / 2;

    // The end marker's CENTRE is at the right edge, inset only by the stroke's
    // half width — not at an independently chosen `w - 3`.
    expect(pts[pts.length - 1].x).toBeCloseTo(width - strokeHalf, 5);
    expect(Number(marker.getAttribute('cx'))).toBeCloseTo(width - strokeHalf, 1);
    // ...and the wash closes on the same x the line ends at.
    const wash = (svg.querySelector('polygon')?.getAttribute('points') ?? '').split(' ');
    expect(Number(wash[wash.length - 2].split(',')[0])).toBeCloseTo(width - strokeHalf, 1);
    expect(Number(wash[wash.length - 1].split(',')[0])).toBeCloseTo(pts[0].x, 1);
  });

  it('spaces points by elapsed time, so a sampling gap reads as a gap', () => {
    // 5s, 90s, 5s apart in a 100s window: the middle gap must be eighteen
    // times the others, not one uniform step like an index-spaced chart. The
    // window is short so the gaps are tens of pixels — at an hour they'd be
    // fractions of one, and the 0.1px coordinate rounding would dominate.
    const el = mount({
      vitals: [
        {
          id: 'burn',
          label: 'Burn',
          value: '$1.40',
          series: agedSeries(
            [
              [100_000, 1],
              [95_000, 2],
              [5_000, 1.5],
              [0, 3],
            ],
            100_000
          ),
        },
      ],
    });
    const pts = polylinePoints(el.querySelector('.monitor-tile__plot svg') as SVGElement);
    const gaps = [pts[1].x - pts[0].x, pts[2].x - pts[1].x, pts[3].x - pts[2].x];
    expect(gaps[1] / gaps[0]).toBeCloseTo(18, 1);
    expect(gaps[1] / gaps[2]).toBeCloseTo(18, 1);
  });

  it('renders a short history as a short trace on the right, not a full-width one', () => {
    // 40 seconds inside a one-hour window is ~1% of the axis. The old
    // index-spaced chart stretched it across the whole tile.
    const el = mount({
      vitals: [
        {
          id: 'burn',
          label: 'Burn',
          value: '$1.40',
          series: agedSeries([
            [40_000, 1],
            [20_000, 2],
            [0, 3],
          ]),
        },
      ],
    });
    const svg = el.querySelector('.monitor-tile__plot svg') as SVGElement;
    const width = Number(svg.getAttribute('width'));
    const pts = polylinePoints(svg);
    const covered = pts[pts.length - 1].x - pts[0].x;
    expect(covered / width).toBeGreaterThan(0);
    expect(covered / width).toBeLessThan(0.03);
    // Still anchored at the right edge — "now" never floats.
    expect(pts[pts.length - 1].x).toBeCloseTo(width - 1, 5);
  });

  it('drops the plot resize observers when the panel is removed', () => {
    const observed: Element[] = [];
    const disconnected: ResizeObserver[] = [];
    const Native = globalThis.ResizeObserver;
    class SpyObserver extends Native {
      observe(target: Element, options?: ResizeObserverOptions): void {
        observed.push(target);
        super.observe(target, options);
      }
      disconnect(): void {
        disconnected.push(this);
        super.disconnect();
      }
    }
    globalThis.ResizeObserver = SpyObserver as unknown as typeof ResizeObserver;
    try {
      const el = mount({
        vitals: [
          { id: 'burn', label: 'Burn', value: '$1', series: evenSeries([1, 2]) },
          { id: 'load', label: 'Load', value: '2', series: evenSeries([2, 3]) },
        ],
      });
      expect(observed).toHaveLength(2);
      // A re-render (the panel refreshes every 5s) drops the previous batch.
      el.model = {
        vitals: [{ id: 'burn', label: 'Burn', value: '$1', series: evenSeries([1, 3]) }],
      };
      expect(disconnected).toHaveLength(2);
      el.remove();
      expect(disconnected).toHaveLength(3);
    } finally {
      globalThis.ResizeObserver = Native;
    }
  });
});

describe('slicc-monitor — attention', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('shows an all-clear line when there is nothing wrong', () => {
    const el = mount({ alerts: [] });
    expect(el.querySelector('.monitor-clear')).not.toBeNull();
    expect(el.querySelector('.monitor-alert')).toBeNull();
    expect(el.querySelector('.monitor-pill--ok')?.textContent).toBe('0');
  });

  it('renders one row per alert, with title, detail, and age', () => {
    const el = mount({
      alerts: [
        {
          id: 'oauth:github',
          severity: 'error',
          title: 'github session expired',
          detail: 'Tool calls will fail',
          age: '2m ago',
        },
      ],
    });
    const alert = el.querySelector('.monitor-alert') as HTMLElement;
    expect(alert.dataset.severity).toBe('error');
    expect(alert.querySelector('.monitor-alert__title')?.textContent).toBe(
      'github session expired'
    );
    expect(alert.querySelector('.monitor-alert__detail')?.textContent).toBe('Tool calls will fail');
    expect(alert.querySelector('.monitor-alert__age')?.textContent).toBe('2m ago');
  });

  it('escalates the count pill to the worst severity present', () => {
    const warn = mount({ alerts: [{ id: 'a', severity: 'warn', title: 'a' }] });
    expect(warn.querySelector('.monitor-pill--warn')?.textContent).toBe('1');
    document.body.replaceChildren();
    const error = mount({
      alerts: [
        { id: 'a', severity: 'warn', title: 'a' },
        { id: 'b', severity: 'error', title: 'b' },
      ],
    });
    expect(error.querySelector('.monitor-pill--error')?.textContent).toBe('2');
  });

  it('omits the block entirely when alerts are not supplied', () => {
    const el = mount({ sections: SAMPLE_SECTIONS });
    expect(el.querySelector('[data-block="attention"]')).toBeNull();
  });
});

describe('slicc-monitor — topology', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('renders a group per section with its id and status', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const groups = el.querySelectorAll<HTMLElement>('.monitor-group');
    expect(groups).toHaveLength(3);
    expect([...groups].map((g) => g.dataset.section)).toEqual([
      'scoops',
      'automations',
      'integrations',
    ]);
  });

  it('shows the summary line, not a bare count', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const summaries = el.querySelectorAll('.monitor-row__summary');
    expect(summaries[0].textContent).toBe('2 · 1 working');
  });

  it('renders rows with name, meta, sublabel, and badges', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const child = el.querySelector('.monitor-child') as HTMLElement;
    expect(child.querySelector('.monitor-child__name')?.textContent).toBe('sliccy (cone)');
    expect(child.querySelector('.monitor-child__meta')?.textContent).toBe('working');
    expect(child.querySelector('.monitor-child__sublabel')?.textContent).toBe(
      'Cone · primary workspace agent'
    );
    expect([...child.querySelectorAll('.monitor-badge')].map((b) => b.textContent)).toEqual([
      'browser',
      'shell',
    ]);
  });

  it('indents a nested row so the cone → scoop tree reads as one', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const children = el.querySelectorAll<HTMLElement>('.monitor-child');
    expect(Number.parseFloat(getComputedStyle(children[1]).paddingLeft)).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(children[0]).paddingLeft)
    );
  });

  it('derives group status from the worst row when not set explicitly', () => {
    const el = mountSections([
      {
        id: 'mounts',
        label: 'Mounts',
        count: 2,
        rows: [
          { name: '/a', meta: 'ok', status: 'active' },
          { name: '/b', meta: 'lost', status: 'warn' },
        ],
      },
    ]);
    expect(el.querySelector<HTMLElement>('.monitor-group')?.dataset.status).toBe('warn');
  });

  it('prefers an explicit group status over the derived one', () => {
    const el = mountSections([
      {
        id: 'tray',
        label: 'Tray',
        count: 1,
        status: 'error',
        rows: [{ name: 'Leader', meta: 'ok', status: 'active' }],
      },
    ]);
    expect(el.querySelector<HTMLElement>('.monitor-group')?.dataset.status).toBe('error');
  });

  it('states every status in words, never in color alone', () => {
    const el = mountSections([
      { id: 'a', label: 'A', count: 1, status: 'warn', rows: [{ name: 'x', meta: 'y' }] },
    ]);
    expect(el.querySelector('.monitor-row__state')?.textContent).toContain('Attention');
  });

  it('collapses a healthy group and expands one that needs attention', () => {
    const el = mountSections([
      { id: 'ok', label: 'Ok', count: 1, status: 'active', rows: [{ name: 'a', meta: 'b' }] },
      { id: 'bad', label: 'Bad', count: 1, status: 'warn', rows: [{ name: 'c', meta: 'd' }] },
    ]);
    const [healthy, degraded] = el.querySelectorAll('.monitor-group');
    expect(healthy.querySelector('.monitor-children')?.hasAttribute('hidden')).toBe(true);
    expect(degraded.querySelector('.monitor-children')?.hasAttribute('hidden')).toBe(false);
  });

  it('keeps a degraded group closed once the reader shuts it', () => {
    const el = mountSections([
      { id: 'bad', label: 'Bad', count: 1, status: 'warn', rows: [{ name: 'c', meta: 'd' }] },
    ]);
    (el.querySelector('.monitor-row') as HTMLElement).click();
    expect(el.querySelector('.monitor-children')?.hasAttribute('hidden')).toBe(true);
    expect(JSON.parse(localStorage.getItem('slicc_monitor_collapsed') ?? '[]')).toContain('bad');
  });

  it('keeps a healthy group open across a re-render once the reader opens it', () => {
    // The 5s refresh re-renders from scratch; without the session-level
    // "expanded" set, a group you just opened would slam shut on the next tick.
    const sections: MonitorSection[] = [
      { id: 'ok', label: 'Ok', count: 1, status: 'active', rows: [{ name: 'a', meta: 'b' }] },
    ];
    const el = mountSections(sections);
    (el.querySelector('.monitor-row') as HTMLElement).click();
    expect(el.querySelector('.monitor-children')?.hasAttribute('hidden')).toBe(false);
    el.sections = sections;
    expect(el.querySelector('.monitor-children')?.hasAttribute('hidden')).toBe(false);
  });

  it('restores collapsed state from localStorage', () => {
    localStorage.setItem('slicc_monitor_collapsed', JSON.stringify(['scoops']));
    const el = mountSections(SAMPLE_SECTIONS);
    const scoops = el.querySelector('[data-section="scoops"] .monitor-children');
    expect(scoops?.hasAttribute('hidden')).toBe(true);
  });

  it('renders friendly empty-state copy for a group with no rows', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const empty = el.querySelector('[data-section="integrations"] .monitor-empty');
    expect(empty?.textContent).toContain('Connect a webhook to receive external events.');
  });

  it('wires aria-expanded and aria-controls to the group body', () => {
    const el = mountSections([
      { id: 'bad', label: 'Bad', count: 1, status: 'warn', rows: [{ name: 'c', meta: 'd' }] },
    ]);
    // A click re-renders the panel, so the header has to be re-queried —
    // the clicked element is detached by the time the assertion runs.
    const header = (): HTMLElement => el.querySelector('.monitor-row') as HTMLElement;
    const body = el.querySelector('.monitor-children') as HTMLElement;
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(header().getAttribute('aria-controls')).toBe(body.id);
    header().click();
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(header().getAttribute('aria-controls')).toBe(body.id);
  });
});

describe('slicc-monitor — processes', () => {
  const TABLE = {
    rows: [
      {
        pid: 1024,
        ppid: 1,
        state: 'R',
        status: 'running',
        command: 'node script.js',
        scoop: 'cone',
      },
      { pid: 1025, ppid: 1024, state: 'S', status: 'pending', command: 'rg --json x' },
    ],
    terminated: 1435,
  };

  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('renders a real table, one row per live process', () => {
    const el = mount({ processes: TABLE });
    expect(el.querySelectorAll('.monitor-table tbody tr')).toHaveLength(2);
    expect(el.querySelector<HTMLElement>('.monitor-tr')?.dataset.pid).toBe('1024');
  });

  it('reports the exited count in the header rather than as rows', () => {
    const el = mount({ processes: TABLE });
    expect(el.querySelector('[data-block="processes"] .monitor-block__hint')?.textContent).toBe(
      '2 live · 1,435 exited this session'
    );
  });

  it('omits the exited clause when nothing has exited', () => {
    const el = mount({ processes: { ...TABLE, terminated: 0 } });
    expect(el.querySelector('[data-block="processes"] .monitor-block__hint')?.textContent).toBe(
      '2 live'
    );
  });

  it('states the process state in a word, not only a letter tag', () => {
    const el = mount({ processes: TABLE });
    const cell = el.querySelector('tbody .monitor-td--state') as HTMLElement;
    expect(cell.querySelector('.monitor-stat-tag')?.textContent).toBe('R');
    expect(cell.querySelector('.monitor-stat-word')?.textContent).toBe('running');
  });

  it('sorts on a column header click, and flips on a second click', () => {
    const el = mount({ processes: TABLE });
    const pids = () =>
      [...el.querySelectorAll<HTMLElement>('.monitor-tr')].map((tr) => tr.dataset.pid);
    expect(pids()).toEqual(['1024', '1025']);
    // A sort re-renders the header row, so each `th` has to be re-queried.
    const th = (index: number): HTMLElement =>
      el.querySelectorAll<HTMLElement>('.monitor-th')[index];

    // PID is already the active sort, so the first click flips it.
    th(0).click();
    expect(pids()).toEqual(['1025', '1024']);
    expect(th(0).getAttribute('aria-sort')).toBe('descending');
    th(0).click();
    expect(pids()).toEqual(['1024', '1025']);
    expect(th(0).getAttribute('aria-sort')).toBe('ascending');

    // A different column starts ascending rather than inheriting the flip.
    th(6).click();
    expect(th(6).getAttribute('aria-sort')).toBe('ascending');
    expect(th(0).getAttribute('aria-sort')).toBe('none');
    expect(pids()).toEqual(['1024', '1025']);
  });

  it('filters on command, scoop, and pid', () => {
    const el = mount({ processes: TABLE });
    const search = el.querySelector('.monitor-input') as HTMLInputElement;
    const rowCount = () => el.querySelectorAll('.monitor-tr').length;

    search.value = 'rg --json';
    search.dispatchEvent(new Event('input'));
    expect(rowCount()).toBe(1);

    search.value = 'cone';
    search.dispatchEvent(new Event('input'));
    expect(rowCount()).toBe(1);

    search.value = '1025';
    search.dispatchEvent(new Event('input'));
    expect(rowCount()).toBe(1);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(rowCount()).toBe(2);
  });

  it('says the table is empty rather than showing a bare header', () => {
    const el = mount({ processes: { rows: [], terminated: 0 } });
    expect(el.querySelector('.monitor-empty-cell')?.textContent).toBe('No processes running.');
  });

  it('distinguishes "nothing matches the filter" from "nothing is running"', () => {
    const el = mount({ processes: TABLE });
    const search = el.querySelector('.monitor-input') as HTMLInputElement;
    search.value = 'zzz-no-such-command';
    search.dispatchEvent(new Event('input'));
    expect(el.querySelector('.monitor-empty-cell')?.textContent).toContain(
      'No live process matches'
    );
  });

  it('renders a missing optional column as an em dash, not "undefined"', () => {
    const el = mount({ processes: TABLE });
    const secondRow = el.querySelectorAll('.monitor-tr')[1];
    expect(secondRow.querySelector('.monitor-td--scoop')?.textContent).toBe('—');
  });
});

describe('slicc-monitor — shell', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
    localStorage.removeItem('slicc_monitor_collapsed');
  });

  it('dispatches slicc-monitor-refresh on the re-sync click', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const handler = vi.fn();
    el.addEventListener('slicc-monitor-refresh', handler);
    (el.querySelector('.monitor-head .monitor-btn') as HTMLElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('shows the freshness line when supplied', () => {
    const el = mount({ updated: 'Streaming · updated 2s ago' });
    expect(el.querySelector('.monitor-head__sub')?.textContent).toBe('Streaming · updated 2s ago');
  });

  it('re-renders when the model is replaced', () => {
    const el = mount({ sections: SAMPLE_SECTIONS });
    expect(el.querySelectorAll('.monitor-group')).toHaveLength(3);
    el.model = { sections: [SAMPLE_SECTIONS[0]] };
    expect(el.querySelectorAll('.monitor-group')).toHaveLength(1);
  });

  it('sections getter returns a copy, not a live reference', () => {
    const el = mountSections(SAMPLE_SECTIONS);
    const first = el.sections;
    first[0].label = 'mutated';
    first[0].rows[0].name = 'mutated';
    expect(el.sections[0].label).toBe('Scoops');
    expect(el.sections[0].rows[0].name).toBe('sliccy (cone)');
  });

  it('model getter returns a copy, not a live reference', () => {
    const el = mount({ processes: { rows: [], terminated: 3 }, vitals: [] });
    const model = el.model;
    model.processes!.terminated = 999;
    expect(el.model.processes?.terminated).toBe(3);
  });

  it('re-steps the status hues for dark rather than reusing the light ones', () => {
    // --green measures 4.06:1 on the dark surface, under 4.5:1 for the small
    // status text it carries here; dark has to be selected, not flipped.
    const el = mountSections([
      { id: 'a', label: 'A', count: 1, status: 'active', rows: [{ name: 'x', meta: 'y' }] },
    ]);
    const light = getComputedStyle(el.querySelector('.monitor-glyph--active')!).color;
    setTheme('dark');
    const dark = getComputedStyle(el.querySelector('.monitor-glyph--active')!).color;
    expect(dark).not.toBe(light);
  });
});
