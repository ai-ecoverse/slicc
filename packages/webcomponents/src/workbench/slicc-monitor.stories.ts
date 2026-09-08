import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type {
  MonitorModel,
  MonitorRow,
  MonitorSection,
  MonitorSeries,
  MonitorVital,
  SliccMonitor,
} from './slicc-monitor.js';
import './slicc-monitor.js';

interface MonitorArgs {
  model?: MonitorModel;
}

/** The sparkline window the live panel uses. Stories mirror it. */
const WINDOW_MS = 60 * 60 * 1000;
/** The panel's own refresh cadence. */
const STEP_MS = 5_000;
/** A fixed anchor so story screenshots are byte-stable across runs. */
const NOW = 1_800_000_000_000;

/**
 * Space values at the panel's 5s cadence, ending "now" — the shape the live
 * buffer produces. Values are spaced by TIME, so a story that wants to show a
 * sampling gap just widens one step.
 */
function series(values: number[], step = STEP_MS): MonitorSeries {
  const last = values.length - 1;
  return {
    points: values.map((value, i) => ({ at: NOW - (last - i) * step, value })),
    windowMs: WINDOW_MS,
  };
}

/**
 * The same values, but with the tab backgrounded for 80 seconds in the
 * middle — the sampling gap a throttled timer leaves behind.
 */
function gappedSeries(values: number[]): MonitorSeries {
  const half = Math.floor(values.length / 2);
  const last = values.length - 1;
  return {
    points: values.map((value, i) => ({
      at: NOW - (last - i) * STEP_MS - (i < half ? 80_000 : 0),
      value,
    })),
    windowMs: WINDOW_MS,
  };
}

const BURN = [
  0.9, 1.1, 0.8, 0.6, 0.7, 1.2, 1.6, 1.5, 1.1, 0.9, 1.0, 1.4, 1.9, 2.1, 1.7, 1.3, 1.1, 1.2, 1.5,
  1.8, 1.6, 1.3, 1.35, 1.4,
];
const LOAD = [1, 2, 2, 3, 1, 0, 0, 1, 2, 4, 3, 2, 2, 1, 1, 2, 3, 3, 2, 1, 1, 2, 2, 2];
const PROCS = [4, 7, 9, 6, 3, 2, 8, 12, 15, 11, 9, 6, 5, 9, 14, 18, 16, 12, 9, 7, 11, 13, 14, 9];

/**
 * One dot per context window, in the same chip colors the switcher paints —
 * the cone's `--waffle`-ish brown plus the hashed scoop palette. The peak
 * (0.61) is the curator's; the tile's own figure reports that one, and the
 * three quieter windows behind it are exactly what the bar alone cannot say.
 */
const CONTEXT_MARKERS: NonNullable<MonitorVital['markers']> = [
  { id: 'cone', ratio: 0.44, color: '#b07823', label: 'sliccy (cone) — 44% full' },
  { id: 'loose-ends', ratio: 0.12, color: '#8b5cf6', label: 'loose-ends — 12% full' },
  { id: 'review', ratio: 0.28, color: '#3b82f6', label: 'review — 28% full' },
  {
    id: 'agent-memory-curator',
    ratio: 0.61,
    color: '#06b6d4',
    label: 'agent-memory-curator — 61% full',
  },
];

function vitals(): MonitorModel['vitals'] {
  return [
    {
      id: 'burn',
      label: 'Burn rate',
      value: '$1.40',
      unit: '/hour',
      hero: true,
      series: series(BURN),
      foot: '$29.06 this session · last 5m',
    },
    {
      id: 'load',
      label: 'Agent load',
      value: '2',
      unit: 'of 4 working',
      accent: 'violet',
      series: series(LOAD),
      foot: 'last 5m',
    },
    {
      id: 'processes',
      label: 'Live processes',
      value: '9',
      unit: 'processes',
      accent: 'cyan',
      series: series(PROCS),
      foot: '1,435 exited this session',
    },
    {
      id: 'context',
      label: 'Context fill',
      value: '61',
      unit: '%',
      ratio: 0.61,
      markers: CONTEXT_MARKERS,
      accent: 'green',
      foot: 'fullest of 4 context windows',
    },
  ];
}

function healthySections(): MonitorModel['sections'] {
  return [
    {
      id: 'tray',
      label: 'Tray',
      icon: 'cloud',
      count: 1,
      meta: 'leader · connected',
      accent: 'waffle',
      status: 'active',
      rows: [
        {
          name: 'Leader',
          sublabel: 'Session f77471ec · Worker · tray.sliccy.ai',
          meta: 'connected',
          badges: ['join URL'],
          status: 'active',
        },
      ],
    },
    {
      id: 'followers',
      label: 'Followers',
      icon: 'radio',
      count: 1,
      meta: '1 connected',
      accent: 'cyan',
      rows: [
        {
          name: 'CLI · 2fb161d9',
          sublabel: 'slicc-cli exec target · trieloff@',
          meta: 'connected 5h',
          badges: ['ssh'],
          status: 'active',
        },
      ],
    },
    {
      id: 'scoops',
      label: 'Scoops',
      icon: 'bot',
      count: 4,
      meta: '4 · 2 working',
      accent: 'violet',
      status: 'active',
      rows: [
        { name: 'sliccy (cone)', meta: 'working', status: 'active' },
        { name: 'loose-ends', meta: 'idle', depth: 1 },
        { name: 'review', meta: 'idle', depth: 1 },
        { name: 'agent-memory-curator', meta: 'working', status: 'active', depth: 1 },
      ],
    },
    {
      id: 'mounts',
      label: 'Mounts',
      icon: 'hard-drive',
      count: 2,
      meta: '2 · all granted',
      status: 'active',
      rows: [
        { name: '/mnt/da-aem', meta: 'da', status: 'idle' },
        { name: '/mnt/photos', meta: 'local', status: 'active' },
      ],
    },
    {
      id: 'integrations',
      label: 'Integrations',
      icon: 'blocks',
      count: 6,
      meta: '3 servers · 12 tools · 3 accounts valid',
      accent: 'waffle',
      status: 'active',
      rows: [
        { name: 'github', meta: 'MCP · 6 tools', status: 'active' },
        { name: 'context7', meta: 'MCP · 2 tools', status: 'active' },
        { name: 'ios-simulator', meta: 'MCP · 4 tools', status: 'active' },
        { name: 'anthropic', meta: 'account', status: 'active' },
      ],
    },
    {
      id: 'automations',
      label: 'Automations',
      icon: 'calendar-clock',
      count: 4,
      meta: '4 webhooks · no cron tasks',
      accent: 'amber',
      rows: [
        { name: 'speck-lick', meta: '→ speck-worker' },
        { name: 'review-lick', meta: '→ review' },
      ],
    },
    {
      id: 'cost',
      label: 'Cost',
      icon: 'receipt',
      count: 4,
      meta: '$29.06 across 4 models',
      accent: 'rose',
      rows: [
        { name: 'claude-opus-5', meta: '$20.3407' },
        { name: 'grok-4.6', meta: '$1.8534' },
        { name: 'us.anthropic.claude-opus-4-6', meta: '$1.3633' },
        { name: 'grok-4.5', meta: '$1.0678' },
      ],
    },
  ];
}

function processes(): MonitorModel['processes'] {
  return {
    terminated: 1435,
    rows: [
      {
        pid: 1,
        ppid: 0,
        state: 'R',
        status: 'running',
        started: '12:58',
        elapsed: '5h 15m',
        scoop: 'system',
        command: 'kernel',
      },
      {
        pid: 41822,
        ppid: 1,
        state: 'R',
        status: 'running',
        started: '18:01',
        elapsed: '12m 18s',
        scoop: 'cone',
        command: 'node packages/dev-tools/tools/coverage-ratchet.mjs',
      },
      {
        pid: 41830,
        ppid: 41822,
        state: 'R',
        status: 'running',
        started: '18:01',
        elapsed: '12m 11s',
        scoop: 'cone',
        command: 'vitest run --coverage',
      },
      {
        pid: 41904,
        ppid: 1,
        state: 'R',
        status: 'running',
        started: '18:09',
        elapsed: '4m 02s',
        scoop: '2fb161d9',
        command: 'slicc-cli exec -- rg --json "MonitorSection"',
      },
      {
        pid: 41911,
        ppid: 41904,
        state: 'S',
        status: 'pending',
        started: '18:09',
        elapsed: '4m 01s',
        scoop: '2fb161d9',
        command: 'rg --json MonitorSection packages/',
      },
      {
        pid: 42003,
        ppid: 1,
        state: 'R',
        status: 'running',
        started: '18:11',
        elapsed: '1m 44s',
        scoop: 'curator',
        command: 'python3 -c "import json,sys; …"',
      },
      {
        pid: 42008,
        ppid: 42003,
        state: 'S',
        status: 'pending',
        started: '18:11',
        elapsed: '1m 43s',
        scoop: 'curator',
        command: 'sleep 120',
      },
      {
        pid: 42044,
        ppid: 1,
        state: 'R',
        status: 'running',
        started: '18:12',
        elapsed: '38s',
        scoop: 'review',
        command: 'git log --oneline -n 200',
      },
      {
        pid: 42051,
        ppid: 42044,
        state: 'R',
        status: 'running',
        started: '18:13',
        elapsed: '6s',
        scoop: 'review',
        command: 'gh pr view 2381 --json statusCheckRollup',
      },
    ],
  };
}

const HEALTHY: MonitorModel = {
  updated: 'Streaming · updated 2s ago',
  vitals: vitals(),
  alerts: [],
  sections: healthySections(),
  processes: processes(),
};

function degradedSections(): MonitorModel['sections'] {
  const sections = healthySections() ?? [];
  const followers = sections[1];
  followers.status = 'warn';
  followers.meta = '1 connected · 1 stalled';
  followers.rows = [
    ...followers.rows,
    {
      name: 'QA iPad · 9c31f0a2',
      sublabel: 'iPadOS 19 · SliccFollower 1.7',
      meta: 'stalled 12m',
      badges: ['playwright'],
      status: 'warn',
    },
  ];

  const mounts = sections[3];
  mounts.status = 'warn';
  mounts.meta = '2 · 1 need re-grant';
  mounts.rows[1] = { name: '/mnt/photos', meta: 'permission lost', status: 'warn' };

  const integrations = sections[4];
  integrations.status = 'error';
  integrations.meta = '3 servers · 12 tools · 1 account expired';
  integrations.rows[3] = { name: 'github', meta: 'session expired', status: 'error' };
  return sections;
}

const DEGRADED: MonitorModel = {
  updated: 'Streaming · updated 2s ago',
  vitals: vitals(),
  alerts: [
    {
      id: 'oauth:github',
      severity: 'error',
      icon: 'key-round',
      title: 'github session expired',
      detail: 'Tool calls through this provider will fail until it is signed in again.',
    },
    {
      id: 'follower:qa-ipad',
      severity: 'warn',
      icon: 'radio',
      title: 'QA iPad stopped answering',
      detail: 'iPadOS 19 · SliccFollower 1.7',
      age: 'stalled 12m',
    },
    {
      id: 'mount:/mnt/photos',
      severity: 'warn',
      icon: 'folder-lock',
      title: '/mnt/photos needs re-grant',
      detail: 'File System Access permission is no longer granted for this handle.',
    },
  ],
  sections: degradedSections(),
  processes: processes(),
};

const COLD_START: MonitorModel = {
  updated: 'Streaming · just started',
  vitals: [
    {
      id: 'burn',
      label: 'Burn rate',
      value: '$0.00',
      unit: '/hour',
      hero: true,
      foot: 'no spend yet',
    },
    { id: 'load', label: 'Agent load', value: '0', unit: 'of 1 working', accent: 'violet' },
    { id: 'processes', label: 'Live processes', value: '1', unit: 'process', accent: 'cyan' },
  ],
  alerts: [],
  sections: (healthySections() ?? []).map((section) => ({
    ...section,
    count: 0,
    rows: [],
    meta: undefined,
    status: 'idle' as const,
  })),
  processes: { rows: [], terminated: 0 },
};

/**
 * Mount the monitor in a workbench-sized container so the panel reads in its
 * real context. Height is auto: the design's claim is that a healthy system
 * fits without scrolling, and a fixed frame would hide whether that holds.
 */
function buildMonitor({ model = HEALTHY }: MonitorArgs): HTMLElement {
  const stage = document.createElement('main');
  stage.style.cssText =
    'width:100%;min-height:100vh;padding:24px;box-sizing:border-box;background:var(--bg);';

  const container = document.createElement('div');
  container.style.cssText =
    'width:min(1120px,100%);margin:0 auto;border:1px solid var(--line);' +
    'border-radius:16px;overflow:hidden;box-shadow:var(--shadow-pane);box-sizing:border-box;';

  const monitor = document.createElement('slicc-monitor') as SliccMonitor;
  monitor.model = model;

  container.appendChild(monitor);
  stage.appendChild(container);
  return stage;
}

const meta: Meta<MonitorArgs> = {
  title: 'Workbench/Monitor',
  component: 'slicc-monitor',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  render: buildMonitor,
};

export default meta;
type Story = StoryObj<MonitorArgs>;

/**
 * A healthy system. Note what is absent: no summed count of unlike things, no
 * card per resource, no list of dead processes. Attention is one "All clear"
 * line and every healthy topology group is one line.
 */
export const Healthy: Story = {
  args: { model: HEALTHY },
};

/**
 * Three things wrong. The attention feed leads and names each one; the
 * topology groups that contain them auto-expand while the healthy ones stay
 * shut. Every status is carried by glyph shape AND a word — `--amber` is
 * 2.09:1 on the light surface, so color alone would not clear contrast.
 */
export const NeedsAttention: Story = {
  args: { model: DEGRADED },
};

/**
 * First render of a fresh session: no history to plot, no spend, nothing
 * mounted. Every tile still reads as a number rather than a blank, and no
 * sparkline is drawn from a single point.
 */
export const ColdStart: Story = {
  args: { model: COLD_START },
};

/**
 * A panel opened two minutes ago, with a gap where the tab was backgrounded
 * and its timers were throttled.
 *
 * The traces hug the RIGHT edge and cover only the slice of the hour they
 * actually hold — a short history draws a short trace instead of stretching
 * two minutes across the tile — and the throttled stretch shows as a long
 * flat run between two samples rather than being drawn as if it never
 * happened.
 */
export const PartialWindow: Story = {
  args: {
    model: {
      updated: 'Streaming · updated just now',
      vitals: [
        {
          id: 'burn',
          label: 'Burn rate',
          value: '$1.40',
          unit: '/hour',
          hero: true,
          series: gappedSeries(BURN.slice(0, 12)),
          foot: '$2.71 this session · last 2m',
        },
        {
          id: 'load',
          label: 'Agent load',
          value: '2',
          unit: 'of 4 working',
          accent: 'violet',
          series: gappedSeries(LOAD.slice(0, 12)),
          foot: 'last 2m',
        },
        {
          id: 'processes',
          label: 'Live processes',
          value: '9',
          unit: 'processes',
          accent: 'cyan',
          series: gappedSeries(PROCS.slice(0, 12)),
          foot: 'last 2m',
        },
      ],
      alerts: [],
    },
  },
};

/**
 * The context meter alone, in the three shapes that make the dots worth
 * drawing.
 *
 * Top: one window is about to compact and five others are nearly empty — the
 * bar says "91%", the dots say only the curator is in trouble. Middle: the
 * same 91% peak, but everything is crowded up against it, which is a very
 * different thing to be told. Bottom: the ends, where a 0% and a 100% dot
 * still sit fully over the track instead of hanging off it.
 */
export const ContextDistribution: Story = {
  args: {
    model: {
      updated: 'Streaming · updated just now',
      vitals: [
        {
          id: 'context-spread',
          label: 'Context fill',
          value: '91',
          unit: '%',
          ratio: 0.91,
          accent: 'rose',
          markers: [
            { id: 'a', ratio: 0.91, color: '#06b6d4', label: 'agent-memory-curator — 91% full' },
            { id: 'b', ratio: 0.09, color: '#b07823', label: 'sliccy (cone) — 9% full' },
            { id: 'c', ratio: 0.14, color: '#8b5cf6', label: 'loose-ends — 14% full' },
            { id: 'd', ratio: 0.11, color: '#3b82f6', label: 'review — 11% full' },
            { id: 'e', ratio: 0.06, color: '#10b981', label: 'docs-sweep — 6% full' },
            { id: 'f', ratio: 0.17, color: '#f59e0b', label: 'speck-worker — 17% full' },
          ],
          foot: 'fullest of 6 context windows',
        },
        {
          id: 'context-crowded',
          label: 'Context fill',
          value: '91',
          unit: '%',
          ratio: 0.91,
          accent: 'rose',
          markers: [
            { id: 'a', ratio: 0.91, color: '#06b6d4', label: 'agent-memory-curator — 91% full' },
            { id: 'b', ratio: 0.86, color: '#b07823', label: 'sliccy (cone) — 86% full' },
            { id: 'c', ratio: 0.88, color: '#8b5cf6', label: 'loose-ends — 88% full' },
            { id: 'd', ratio: 0.83, color: '#3b82f6', label: 'review — 83% full' },
            { id: 'e', ratio: 0.79, color: '#10b981', label: 'docs-sweep — 79% full' },
            { id: 'f', ratio: 0.9, color: '#f59e0b', label: 'speck-worker — 90% full' },
          ],
          foot: 'fullest of 6 context windows',
        },
        {
          id: 'context-ends',
          label: 'Context fill',
          value: '100',
          unit: '%',
          ratio: 1,
          accent: 'rose',
          markers: [
            { id: 'a', ratio: 1, color: '#ef4444', label: 'overflowing — 100% full' },
            { id: 'b', ratio: 0, color: '#b07823', label: 'sliccy (cone) — 0% full' },
            { id: 'c', ratio: 0.5, color: '#10b981', label: 'docs-sweep — 50% full' },
          ],
          foot: 'fullest of 3 context windows',
        },
      ],
      alerts: [],
    },
  },
};

/** Just the process table, at the size a busy session reaches. */
export const ProcessTable: Story = {
  args: { model: { updated: 'Streaming', processes: processes() } },
};

// ---------------------------------------------------------------------------
// Budget-mode cost surfaces
//
// Some providers do not meter per token: they hand out a rolling allowance —
// Adobe's LLM proxy reports one 7-day window — and the number that decides
// whether work continues this afternoon is how much of THAT is gone. Session
// dollars stay true and stay on the panel, demoted out of the hero slot: a
// family-priced model can bill $0.00 while the shared window burns down, so a
// `$` hero would report "nothing is happening" during the hour that ends the
// week's work.
//
// The convention, matching the provider's own `/v1/usage` payload, is percent
// USED — never remaining. One direction on every surface.
// ---------------------------------------------------------------------------

/** The budget window as the panel's hero tile. `resets` copy is host-formatted. */
function budgetHero(
  percent: number,
  opts: { accent: MonitorVital['accent']; foot: string }
): MonitorVital {
  return {
    id: 'budget',
    label: 'Weekly budget',
    // A decimal below 10 and a whole number above it: 9.5 is the difference
    // between "nothing yet" and "the morning cost a tenth of the week"; 63.2
    // vs 63 is noise on a number that moves in whole units.
    value: percent < 10 ? String(Number(percent.toFixed(1))) : String(Math.round(percent)),
    unit: '% used',
    hero: true,
    // The bar clamps where the figure does not — an overrun window still
    // reports 104%.
    ratio: Math.min(1, percent / 100),
    accent: opts.accent,
    foot: opts.foot,
  };
}

/**
 * Vitals in budget mode: the window leads, burn rate keeps its sparkline as an
 * ordinary tile. Demoted, not deleted — "$1.40/hour" is still the fastest way
 * to see that a runaway scoop is eating the allowance.
 *
 * The row stays FOUR tiles wide. The grid is four fixed columns (`1.6fr 1fr
 * 1fr 1fr`), so a fifth tile wraps onto a second row at hero width and the
 * panel stops fitting without scrolling. Live processes is the tile that
 * yields: it is the only vital repeated verbatim by a tier below (the process
 * table's own row count), so losing it costs the panel nothing that is not
 * still on screen.
 */
function budgetVitals(hero: MonitorVital): MonitorModel['vitals'] {
  const rest = (vitals() ?? []).filter((vital) => vital.id !== 'processes');
  const burn = rest.find((vital) => vital.id === 'burn');
  if (burn) {
    burn.hero = false;
    burn.accent = 'rose';
    burn.foot = '$29.06 this session';
  }
  return [hero, ...rest];
}

/** The cost group, headed by the window rather than by the dollar sum. */
function budgetCostSection(meta: string, row: MonitorRow): MonitorSection {
  const cost = (healthySections() ?? []).find((section) => section.id === 'cost');
  if (!cost) throw new Error('cost section missing from healthySections()');
  return {
    ...cost,
    meta,
    status: row.status ?? 'active',
    rows: [row, ...cost.rows],
  };
}

function budgetSections(meta: string, row: MonitorRow): MonitorModel['sections'] {
  return (healthySections() ?? []).map((section) =>
    section.id === 'cost' ? budgetCostSection(meta, row) : section
  );
}

const BUDGET_OK: MonitorModel = {
  updated: 'Streaming · updated 2s ago',
  vitals: budgetVitals(
    budgetHero(9.5, { accent: 'green', foot: 'resets Sun 14 Sep · $29.06 this session' })
  ),
  alerts: [],
  sections: budgetSections('9.5% of weekly budget · $29.06 across 4 models', {
    name: 'Weekly budget',
    sublabel: 'Adobe LLM proxy · rolling 7 days',
    meta: '9.5% used',
    badges: ['resets Sun 14 Sep'],
    status: 'active',
  }),
  processes: processes(),
};

const BUDGET_NEAR_LIMIT: MonitorModel = {
  updated: 'Streaming · updated 2s ago',
  vitals: budgetVitals(
    budgetHero(92, { accent: 'amber', foot: 'resets in 18h · $204.11 this session' })
  ),
  alerts: [
    {
      id: 'budget:weekly',
      severity: 'warn',
      icon: 'gauge',
      title: '92% of the weekly budget used',
      detail: 'Long runs may not finish before the window resets.',
      age: 'resets in 18h',
    },
  ],
  sections: budgetSections('92% of weekly budget · $204.11 across 4 models', {
    name: 'Weekly budget',
    sublabel: 'Adobe LLM proxy · rolling 7 days',
    meta: '92% used',
    badges: ['resets in 18h'],
    status: 'warn',
  }),
  processes: processes(),
};

const BUDGET_RATE_LIMITED: MonitorModel = {
  updated: 'Streaming · updated 2s ago',
  vitals: budgetVitals(
    budgetHero(96, { accent: 'rose', foot: 'rate-limited · resets in 18h · $204.11 this session' })
  ),
  alerts: [
    {
      id: 'budget:weekly',
      severity: 'error',
      icon: 'octagon-alert',
      title: 'Weekly budget is rate-limited',
      detail: 'The provider is refusing calls until the window resets. Queued work will fail.',
      age: 'resets in 18h',
    },
  ],
  sections: budgetSections('rate-limited · 96% of weekly budget used', {
    name: 'Weekly budget',
    sublabel: 'Adobe LLM proxy · rolling 7 days',
    meta: 'rate-limited · 96% used',
    badges: ['resets in 18h'],
    status: 'error',
  }),
  processes: processes(),
};

/**
 * A budget provider, mid-window. The hero is the allowance, not the spend:
 * `9.5% used`, with the reset and the session dollars in the foot. Burn rate
 * keeps its sparkline one tile over, and the Cost group leads with the window
 * before its per-model dollars.
 */
export const BudgetMode: Story = {
  args: { model: BUDGET_OK },
};

/**
 * 92% through the window. Amber from 80% — carried by the meter, the alert
 * copy AND the group's status word, never by color alone (`--amber` is 2.09:1
 * on this surface).
 */
export const BudgetNearLimit: Story = {
  args: { model: BUDGET_NEAR_LIMIT },
};

/**
 * The provider has started refusing calls. This is a different fact from a
 * high number — the reported percent lags the refusal, which is why 96% is
 * rose here and 92% was amber above — so it earns an error in the attention
 * feed rather than a warmer tint on the tile.
 */
export const BudgetRateLimited: Story = {
  args: { model: BUDGET_RATE_LIMITED },
};

/**
 * The two billing modes stacked, vitals only — the contrast the change is
 * about.
 *
 * Top: a metered provider, unchanged, headlining `$1.40/hour`. Bottom: the
 * same session on a budget provider, headlining `9.5% used` with burn rate
 * demoted to an ordinary tile. Same tiles, same grid; only which one is 48px
 * changes.
 */
export const HeadlineContrast: Story = {
  render: () => {
    const stage = document.createElement('main');
    stage.style.cssText =
      'width:100%;min-height:100vh;padding:24px;box-sizing:border-box;background:var(--bg);' +
      'display:flex;flex-direction:column;gap:20px;';

    const block = (title: string, note: string, model: MonitorModel) => {
      const wrap = document.createElement('section');
      wrap.style.cssText = 'width:min(1120px,100%);margin:0 auto;';
      const heading = document.createElement('h3');
      heading.style.cssText =
        'font:600 12px/1 var(--ui,system-ui);margin:0 0 4px;color:var(--ink,#111);';
      heading.textContent = title;
      const p = document.createElement('p');
      p.style.cssText =
        'font:11px/1.4 var(--ui,system-ui);color:var(--txt-2,#666);margin:0 0 10px;';
      p.textContent = note;
      const frame = document.createElement('div');
      frame.style.cssText =
        'border:1px solid var(--line);border-radius:16px;overflow:hidden;' +
        'box-shadow:var(--shadow-pane);box-sizing:border-box;';
      const monitor = document.createElement('slicc-monitor') as SliccMonitor;
      monitor.model = model;
      frame.appendChild(monitor);
      wrap.append(heading, p, frame);
      return wrap;
    };

    stage.append(
      block(
        'Metered provider — today, unchanged',
        'Per-token pricing: burn rate is the hero, session spend is its foot.',
        { updated: 'Streaming · updated 2s ago', vitals: vitals(), alerts: [] }
      ),
      block(
        'Budget provider — percent USED leads',
        'A shared rolling window. Dollars can read $0.00 on family pricing while the allowance burns down, so the window is the hero and burn rate becomes an ordinary tile.',
        { updated: 'Streaming · updated 2s ago', vitals: BUDGET_OK.vitals, alerts: [] }
      )
    );
    return stage;
  },
};
