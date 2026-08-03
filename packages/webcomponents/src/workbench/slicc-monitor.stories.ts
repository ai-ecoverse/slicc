import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { MonitorSection, SliccMonitor } from './slicc-monitor.js';
import './slicc-monitor.js';

interface MonitorArgs {
  sections?: MonitorSection[];
}

const FULLY_POPULATED: MonitorSection[] = [
  {
    id: 'followers',
    label: 'Followers',
    count: 3,
    meta: '2 connected · 1 stalled',
    accent: 'cyan',
    rows: [
      {
        name: 'Lars’s iPhone',
        sublabel: 'iOS 19 · SliccFollower 1.8',
        meta: 'connected 8m',
        icon: 'smartphone',
        badges: ['browser', 'files', 'camera'],
        status: 'active',
      },
      {
        name: 'Studio display',
        sublabel: 'macOS 16 · Slicc CLI',
        meta: 'connected 42m',
        icon: 'monitor',
        badges: ['browser', 'shell', 'clipboard'],
        status: 'active',
      },
      {
        name: 'QA iPad',
        sublabel: 'iPadOS 19 · SliccFollower 1.7',
        meta: 'stalled 2m',
        icon: 'tablet',
        badges: ['browser', 'camera'],
        status: 'warn',
      },
    ],
  },
  {
    id: 'scoops',
    label: 'Scoops',
    count: 3,
    meta: '1 working',
    accent: 'violet',
    rows: [
      {
        name: 'Sliccy',
        sublabel: 'Cone · primary workspace agent',
        meta: '12m 18s',
        icon: 'bot',
        badges: ['browser', 'shell', 'memory'],
        status: 'active',
      },
      {
        name: 'Researcher',
        sublabel: 'Scoop · source gathering',
        meta: 'idle 4m',
        icon: 'search',
        badges: ['web', 'files'],
        status: 'idle',
      },
      {
        name: 'Verifier',
        sublabel: 'Scoop · regression review',
        meta: 'idle 11m',
        icon: 'shield-check',
        badges: ['shell', 'tests'],
        status: 'idle',
      },
    ],
  },
  {
    id: 'processes',
    label: 'Processes',
    count: 3,
    meta: '2 running',
    accent: 'green',
    rows: [
      {
        name: 'Storybook',
        sublabel: 'storybook dev · port 6006',
        meta: 'running 18m',
        icon: 'panels-top-left',
        badges: ['service'],
        status: 'active',
      },
      {
        name: 'Browser tests',
        sublabel: 'vitest · Chromium',
        meta: 'running 36s',
        icon: 'flask-conical',
        badges: ['test'],
        status: 'active',
      },
      {
        name: 'Build #1842',
        sublabel: 'webcomponents · completed',
        meta: '2m ago',
        icon: 'package-check',
        badges: ['build'],
        status: 'idle',
      },
    ],
  },
  {
    id: 'automations',
    label: 'Automations',
    count: 2,
    meta: 'next in 3m',
    accent: 'amber',
    rows: [
      {
        name: 'Health sweep',
        sublabel: 'Every 5 minutes · cone',
        meta: 'in 3m',
        icon: 'heart-pulse',
        badges: ['cron'],
        status: 'active',
      },
      {
        name: 'Daily archive',
        sublabel: 'At 03:00 · workspace',
        meta: 'in 9h',
        icon: 'archive',
        badges: ['cron', 'files'],
        status: 'idle',
      },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    count: 3,
    meta: '12 capabilities',
    accent: 'waffle',
    rows: [
      {
        name: 'GitHub',
        sublabel: 'MCP server · repository access',
        meta: '6 tools',
        icon: 'github',
        badges: ['issues', 'pulls', 'actions'],
        status: 'active',
      },
      {
        name: 'Workspace',
        sublabel: 'MCP server · Intent space',
        meta: '4 tools',
        icon: 'blocks',
        badges: ['notes', 'agents'],
        status: 'active',
      },
      {
        name: 'Cloudflare',
        sublabel: 'OAuth · tray worker',
        meta: '2 tools',
        icon: 'cloud',
        badges: ['deploy', 'logs'],
        status: 'idle',
      },
    ],
  },
  {
    id: 'cost',
    label: 'Cost',
    count: 2,
    meta: '$1.23 this session',
    accent: 'rose',
    rows: [
      {
        name: 'claude-opus-4-6',
        sublabel: '3.8M input · 92K output',
        meta: '$0.87',
        icon: 'sparkles',
        badges: ['reasoning'],
        status: 'active',
      },
      {
        name: 'claude-sonnet-4-6',
        sublabel: '1.1M input · 48K output',
        meta: '$0.36',
        icon: 'zap',
        badges: ['fast'],
        status: 'idle',
      },
    ],
  },
];

const ALL_EMPTY: MonitorSection[] = [
  {
    id: 'followers',
    label: 'Followers',
    count: 0,
    rows: [],
    accent: 'cyan',
    emptyText: 'Pair a phone, tablet, or CLI follower to lend the cone new capabilities.',
  },
  {
    id: 'scoops',
    label: 'Scoops',
    count: 0,
    rows: [],
    accent: 'violet',
    emptyText: 'Delegate a focused task and its scoop will show up here.',
  },
  {
    id: 'processes',
    label: 'Processes',
    count: 0,
    rows: [],
    accent: 'green',
    emptyText: 'Commands and background services will appear as they start.',
  },
  {
    id: 'automations',
    label: 'Automations',
    count: 0,
    rows: [],
    accent: 'amber',
    emptyText: 'Scheduled tasks and webhook-driven licks will appear here.',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    count: 0,
    rows: [],
    accent: 'waffle',
    emptyText: 'Connect an MCP server or account to extend the workspace.',
  },
  {
    id: 'cost',
    label: 'Cost',
    count: 0,
    rows: [],
    accent: 'rose',
    emptyText: 'Model usage will be summarized after the first turn.',
  },
];

const ERROR_HEAVY: MonitorSection[] = [
  {
    id: 'followers',
    label: 'Followers',
    count: 3,
    meta: '0 connected · 3 need attention',
    accent: 'cyan',
    rows: [
      {
        name: 'Lars’s iPhone',
        sublabel: 'iOS 19 · heartbeat timed out',
        meta: 'lost 4m ago',
        icon: 'smartphone',
        badges: ['browser', 'camera'],
        status: 'error',
      },
      {
        name: 'Studio display',
        sublabel: 'macOS 16 · reconnecting',
        meta: 'retry 3 of 5',
        icon: 'monitor',
        badges: ['browser', 'shell', 'clipboard'],
        status: 'warn',
      },
      {
        name: 'QA iPad',
        sublabel: 'iPadOS 19 · capability sync stalled',
        meta: 'stalled 12m',
        icon: 'tablet',
        badges: ['browser', 'camera'],
        status: 'warn',
      },
    ],
  },
  {
    id: 'processes',
    label: 'Processes',
    count: 3,
    meta: '2 failed · 1 stalled',
    accent: 'rose',
    rows: [
      {
        name: 'Browser tests',
        sublabel: 'vitest · Chromium could not launch',
        meta: 'exit 1',
        icon: 'flask-conical',
        badges: ['test'],
        status: 'error',
      },
      {
        name: 'Tray sync',
        sublabel: 'worker · request timeout',
        meta: 'failed 48s ago',
        icon: 'cloud-off',
        badges: ['service', 'network'],
        status: 'error',
      },
      {
        name: 'Storybook',
        sublabel: 'storybook dev · unresponsive',
        meta: 'stalled 3m',
        icon: 'panels-top-left',
        badges: ['service'],
        status: 'warn',
      },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    count: 2,
    meta: 'authentication required',
    accent: 'amber',
    rows: [
      {
        name: 'GitHub',
        sublabel: 'OAuth session expired',
        meta: '401',
        icon: 'github',
        badges: ['issues', 'pulls'],
        status: 'error',
      },
      {
        name: 'Cloudflare',
        sublabel: 'MCP handshake is taking longer than expected',
        meta: 'retrying',
        icon: 'cloud',
        badges: ['deploy', 'logs'],
        status: 'warn',
      },
    ],
  },
  {
    id: 'automations',
    label: 'Automations',
    count: 2,
    meta: 'last sweep incomplete',
    accent: 'violet',
    rows: [
      {
        name: 'Health sweep',
        sublabel: 'Last run exceeded its 30 second limit',
        meta: 'timed out',
        icon: 'heart-pulse',
        badges: ['cron'],
        status: 'error',
      },
      {
        name: 'Daily archive',
        sublabel: 'Waiting for workspace mount',
        meta: 'delayed 9m',
        icon: 'archive',
        badges: ['cron', 'files'],
        status: 'warn',
      },
    ],
  },
];

/**
 * Mount the monitor in a workbench-sized container so the scrollable dashboard
 * reads in its real context (the workbench surface).
 */
function buildMonitor({ sections = FULLY_POPULATED }: MonitorArgs): HTMLElement {
  const stage = document.createElement('main');
  stage.style.cssText =
    'width:100%;min-height:100vh;padding:24px;box-sizing:border-box;background:var(--bg);';

  const container = document.createElement('div');
  container.style.cssText =
    'width:min(1040px,100%);height:820px;margin:0 auto;border:1px solid var(--line);' +
    'border-radius:16px;overflow:hidden;box-shadow:var(--shadow-pane);box-sizing:border-box;';

  const monitor = document.createElement('slicc-monitor') as SliccMonitor;
  monitor.style.height = '100%';
  monitor.sections = sections;

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
 * Review target: a complete two-column dashboard. The Followers card includes
 * connection-age metadata, capability chips, device details, and a stalled row.
 */
export const FullyPopulated: Story = {
  args: { sections: FULLY_POPULATED },
};

/** Every section uses its own friendly, actionable empty-state message. */
export const AllEmpty: Story = {
  args: { sections: ALL_EMPTY },
};

/** Dense warning and failure coverage with explicit, readable state labels. */
export const ErrorHeavy: Story = {
  args: { sections: ERROR_HEAVY },
};
