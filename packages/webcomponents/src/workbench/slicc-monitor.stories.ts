import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { MonitorSection, SliccMonitor } from './slicc-monitor.js';
import './slicc-monitor.js';

interface MonitorArgs {
  sections?: MonitorSection[];
}

const MOCK_SECTIONS_POPULATED: MonitorSection[] = [
  {
    id: 'cost',
    label: 'Cost',
    count: 2,
    meta: '$1.23',
    rows: [
      { name: 'claude-opus-4-6', meta: '$0.87', active: true },
      { name: 'claude-sonnet-4-6', meta: '$0.36', active: false },
    ],
  },
  {
    id: 'scoops',
    label: 'Scoops',
    count: 2,
    rows: [
      { name: 'sliccy (cone)', meta: 'processing', active: true },
      { name: 'researcher', meta: 'idle' },
    ],
  },
  {
    id: 'processes',
    label: 'Processes',
    count: 3,
    rows: [
      { name: '1024', meta: 'scoop:cone — running', active: true },
      { name: '1025', meta: 'shell:ls — done' },
      { name: '1026', meta: 'js:workflow — running', active: true },
    ],
  },
  {
    id: 'cron',
    label: 'Cron Tasks',
    count: 2,
    rows: [
      { name: 'daily-backup', meta: '0 3 * * *', active: true },
      { name: 'health-check', meta: '*/5 * * * *', active: true },
    ],
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    count: 1,
    rows: [{ name: 'github-push', meta: '→ cone' }],
  },
  {
    id: 'workflows',
    label: 'Workflows',
    count: 0,
    rows: [],
  },
  {
    id: 'mounts',
    label: 'Mounts',
    count: 1,
    rows: [{ name: '/workspace/project', meta: 'local' }],
  },
  {
    id: 'mcp',
    label: 'MCP Servers',
    count: 2,
    rows: [
      { name: 'github', meta: '3 tools' },
      { name: 'slack', meta: '5 tools' },
    ],
  },
  {
    id: 'oauth',
    label: 'OAuth',
    count: 2,
    rows: [
      { name: 'adobe', meta: '' },
      { name: 'github', meta: '' },
    ],
  },
];

const MOCK_SECTIONS_EMPTY: MonitorSection[] = [
  { id: 'cost', label: 'Cost', count: 0, rows: [] },
  { id: 'scoops', label: 'Scoops', count: 0, rows: [] },
  { id: 'processes', label: 'Processes', count: 0, rows: [] },
  { id: 'cron', label: 'Cron Tasks', count: 0, rows: [] },
  { id: 'webhooks', label: 'Webhooks', count: 0, rows: [] },
  { id: 'workflows', label: 'Workflows', count: 0, rows: [] },
  { id: 'mounts', label: 'Mounts', count: 0, rows: [] },
  { id: 'mcp', label: 'MCP Servers', count: 0, rows: [] },
  { id: 'oauth', label: 'OAuth', count: 0, rows: [] },
];

/**
 * Mount the monitor in a workbench-sized container so the scrollable dashboard
 * reads in its real context (the workbench surface).
 */
function buildMonitor({ sections = MOCK_SECTIONS_POPULATED }: MonitorArgs): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText =
    'width:100%;height:600px;background:var(--canvas);' +
    'border:1px solid var(--line);border-radius:8px;overflow:hidden;' +
    'box-shadow:var(--shadow-pane);box-sizing:border-box;';

  const monitor = document.createElement('slicc-monitor') as SliccMonitor;
  monitor.sections = sections;

  container.appendChild(monitor);
  return container;
}

const meta: Meta<MonitorArgs> = {
  title: 'Workbench/Monitor',
  tags: ['autodocs'],
  render: buildMonitor,
};

export default meta;
type Story = StoryObj<MonitorArgs>;

/** The full monitor dashboard with all sections populated. */
export const Populated: Story = {
  args: { sections: MOCK_SECTIONS_POPULATED },
};

/** All sections at count 0 (empty state). */
export const Empty: Story = {
  args: { sections: MOCK_SECTIONS_EMPTY },
};

/** A mix of populated and empty sections showing the dimmed empty-state styling. */
export const MixedStates: Story = {
  args: {
    sections: [
      MOCK_SECTIONS_POPULATED[0], // cost
      MOCK_SECTIONS_POPULATED[1], // scoops
      MOCK_SECTIONS_EMPTY[2], // processes (empty)
      MOCK_SECTIONS_POPULATED[3], // cron
      MOCK_SECTIONS_EMPTY[4], // webhooks (empty)
      MOCK_SECTIONS_POPULATED[7], // mcp
    ],
  },
};

/** A section with an error row (red status dot). */
export const WithErrors: Story = {
  args: {
    sections: [
      {
        id: 'processes',
        label: 'Processes',
        count: 3,
        rows: [
          { name: '1024', meta: 'scoop:cone — running', active: true },
          { name: '1025', meta: 'shell:command — failed', error: true },
          { name: '1026', meta: 'js:workflow — running', active: true },
        ],
      },
      MOCK_SECTIONS_POPULATED[1], // scoops
    ],
  },
};
