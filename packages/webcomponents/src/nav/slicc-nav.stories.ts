import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-nav.js';

import '../primitives/slicc-avatar.js';
import '../primitives/slicc-floatbar.js';
import type { AgentState, ScoopDescriptor, SliccAgentTabs } from '../switcher/slicc-agent-tabs.js';
import '../switcher/slicc-agent-tabs.js';
import '../theme/slicc-theme-toggle.js';

interface NavArgs {
  accent?: string;
}

const DEFAULT_SCOOPS: ScoopDescriptor[] = [
  {
    key: 'cone',
    type: 'cone',
    color: '#b07823',
    label: 'Sliccy',
    eyes: 'open',
    fill: 38,
    state: 'idle',
  },
  {
    key: 'researcher',
    type: 'scoop',
    color: '#06b6d4',
    label: 'researcher',
    eyes: 'open',
    fill: 62,
    state: 'working',
  },
  {
    key: 'designer',
    type: 'scoop',
    color: '#8b5cf6',
    label: 'designer',
    eyes: 'open',
    fill: 46,
    state: 'idle',
  },
  {
    key: 'tester',
    type: 'scoop',
    color: '#f59e0b',
    label: 'tester',
    eyes: 'dead',
    fill: 84,
    state: 'broken',
  },
  {
    key: 'triage',
    type: 'scoop',
    color: '#10b981',
    label: 'triage',
    eyes: 'none',
    fill: 14,
    state: 'initializing',
    ephemeral: true,
  },
];

const DECISION_AGENTS = [
  ['researcher', 'Research', '#06b6d4'],
  ['designer', 'Design', '#8b5cf6'],
  ['tester', 'Testing', '#f59e0b'],
  ['triage', 'Triage', '#10b981'],
  ['writer', 'Writing', '#f43f5e'],
  ['reviewer', 'Review', '#3b82f6'],
  ['planner', 'Planning', '#ec4899'],
  ['builder', 'Build', '#14b8a6'],
  ['analyst', 'Analysis', '#06b6d4'],
  ['editor', 'Editing', '#8b5cf6'],
  ['auditor', 'Audit', '#f59e0b'],
  ['navigator', 'Navigate', '#10b981'],
  ['scribe', 'Scribe', '#f43f5e'],
  ['observer', 'Observe', '#3b82f6'],
  ['architect', 'Architect', '#ec4899'],
  ['operator', 'Operate', '#14b8a6'],
  ['validator', 'Validate', '#06b6d4'],
  ['explorer', 'Explore', '#8b5cf6'],
] as const;
const GRID_STATES = [
  ['idle', 24],
  ['working', 46],
  ['idle', 82],
  ['broken', 30],
  ['working', 58],
  ['idle', 34],
  ['working', 95],
  ['broken', 90],
  ['idle', 44],
  ['working', 48],
  ['idle', 88],
  ['idle', 28],
] as const satisfies readonly (readonly [AgentState, number])[];
const DECISION_DOC =
  'Decision: truncate + micro-glyph with the 10.8s fullness arc + relocated cursor-tracking primary avatar + fixed dot grid. The grid exposes hidden urgency without agent-hue ambiguity, movement, or a count label; its accessible summary carries the information colour cannot.';
const DECISION_COPY =
  'The icon-scale grid preserves hidden urgency without agent-hue ambiguity or motion, while its nine faint wells keep the overflow segment fixed. The popup still lists every hidden scoop with its full micro-glyph. The slower arc carries fullness without tinting the segment, and the relocated focused scoop keeps live, fill-dilated eyes.';

function decisionRoster(): ScoopDescriptor[] {
  const roster: ScoopDescriptor[] = [
    {
      key: 'cone',
      type: 'cone',
      color: '#b07823',
      label: 'Sliccy',
      eyes: 'open',
      fill: 32,
      state: 'idle',
    },
    ...DECISION_AGENTS.map(([key, label, color]) => ({
      key,
      label,
      color,
      type: 'scoop' as const,
      eyes: 'open' as const,
      fill: 32,
      state: 'idle' as const,
    })),
  ];
  roster.slice(7).forEach((agent, index) => {
    const [state, fill] = GRID_STATES[index];
    agent.state = state;
    agent.fill = fill;
    agent.eyes = state === 'broken' ? 'dead' : 'open';
  });
  Object.assign(roster.find((agent) => agent.key === 'designer')!, {
    state: 'working',
    eyes: 'open',
    fill: 76,
  });
  return roster;
}

function makeNav(
  accent?: string,
  scoops: ScoopDescriptor[] = DEFAULT_SCOOPS,
  active = 'cone'
): HTMLElement {
  const nav = document.createElement('slicc-nav');
  if (accent) nav.setAttribute('accent', accent);

  const switcher = document.createElement('slicc-agent-tabs') as SliccAgentTabs;
  switcher.scoops = scoops;
  switcher.active = active;

  const floatbar = document.createElement('slicc-floatbar');
  floatbar.setAttribute('label', 'CLI · tray · 1 follower');
  floatbar.setAttribute('spent', '$2.41');
  floatbar.setAttribute('linked', '');
  floatbar.setAttribute('float-kind', 'npx');
  floatbar.setAttribute('connection', 'live');
  floatbar.setAttribute('tray-role', 'leader');

  const toggle = document.createElement('slicc-theme-toggle');

  const avatar = document.createElement('slicc-avatar');

  avatar.setAttribute('email', 'beau@dodds.net');
  avatar.setAttribute('name', 'Beau Dodds');

  nav.append(switcher, floatbar, toggle, avatar);
  return nav;
}

function appFrame(nav: HTMLElement, width: string, bodyCopy = 'chat shell'): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText = `display:flex;flex-direction:column;width:${width};max-width:100%;height:300px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);font-family:var(--ui);`;

  const body = document.createElement('div');
  body.style.cssText =
    'flex:1;min-height:0;display:grid;place-items:center;color:var(--txt-3);font-size:13px;background:var(--bg);';
  body.textContent = bodyCopy;

  frame.append(nav, body);
  return frame;
}

const meta: Meta<NavArgs> = {
  title: 'Nav/Nav',
  component: 'slicc-nav',
  tags: ['autodocs'],
  argTypes: {
    accent: {
      control: 'color',
      description: 'Context hue → sets --ctx inline; the frosted tint reacts to it',
    },
  },
  render: ({ accent }) => appFrame(makeNav(accent), '980px'),
};

export default meta;
type Story = StoryObj<NavArgs>;

export const Default: Story = { args: {} };

export const Wide: Story = {
  render: ({ accent }) => appFrame(makeNav(accent), '1280px'),
};

export const Mid: Story = {
  render: ({ accent }) => appFrame(makeNav(accent, decisionRoster(), 'designer'), '560px'),
};

export const Narrow: Story = {
  render: ({ accent }) => appFrame(makeNav(accent, decisionRoster(), 'designer'), '360px'),
};

export const Decision: Story = {
  render: ({ accent }) =>
    appFrame(makeNav(accent, decisionRoster(), 'designer'), '1280px', DECISION_COPY),
  parameters: { docs: { description: { story: DECISION_DOC } } },
};

export const AmberContext: Story = { args: { accent: '#f59e0b' } };

export const CyanContext: Story = { args: { accent: '#06b6d4' } };

export const VioletContext: Story = { args: { accent: '#8b5cf6' } };

export const RoseContext: Story = { args: { accent: '#f43f5e' } };

export const MinimalAutoSpacer: Story = {
  render: () => {
    const nav = document.createElement('slicc-nav');
    nav.setAttribute('accent', '#10b981');
    const floatbar = document.createElement('slicc-floatbar');
    floatbar.setAttribute('label', 'cloud · hosted leader');
    floatbar.setAttribute('spent', '$0.18');
    floatbar.setAttribute('float-kind', 'hosted');
    floatbar.setAttribute('connection', 'live');
    floatbar.setAttribute('tray-role', 'leader');
    const avatar = document.createElement('slicc-avatar');
    avatar.setAttribute('name', 'Lars Trieloff');
    nav.append(floatbar, avatar);
    return appFrame(nav, '720px');
  },
};
