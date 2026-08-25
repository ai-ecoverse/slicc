import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { MonitorModel, MonitorSeries, SliccMonitor } from './slicc-monitor.js';
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

/** Just the process table, at the size a busy session reaches. */
export const ProcessTable: Story = {
  args: { model: { updated: 'Streaming', processes: processes() } },
};
