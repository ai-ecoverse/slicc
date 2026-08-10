import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h } from '../internal/dom.js';
import type {
  AgentPhase,
  AgentState,
  ScoopDescriptor,
  SliccAgentTabs,
} from './slicc-agent-tabs.js';
import './slicc-agent-tabs.js';

interface AgentTabsArgs {
  scoops?: ScoopDescriptor[];
  active?: string;
  attention?: string;
  connection?: 'connected' | 'disconnected';
  width?: number;
  overflowOpen?: boolean;
  reducedMotion?: boolean;
}

const BASE_ROSTER: ScoopDescriptor[] = [
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
    label: 'Research',
    eyes: 'open',
    fill: 62,
    state: 'working',
  },
  {
    key: 'designer',
    type: 'scoop',
    color: '#8b5cf6',
    label: 'Design',
    eyes: 'open',
    fill: 46,
    state: 'idle',
  },
  {
    key: 'tester',
    type: 'scoop',
    color: '#f59e0b',
    label: 'Testing',
    eyes: 'dead',
    fill: 84,
    state: 'broken',
  },
  {
    key: 'triage',
    type: 'scoop',
    color: '#10b981',
    label: 'Triage',
    eyes: 'none',
    fill: 14,
    state: 'initializing',
    ephemeral: true,
  },
];

const EXTRA_ROSTER: ScoopDescriptor[] = [
  ...BASE_ROSTER,
  { key: 'writer', color: '#f43f5e', label: 'Writing', eyes: 'open', fill: 78, state: 'idle' },
  { key: 'reviewer', color: '#3b82f6', label: 'Review', eyes: 'open', fill: 30, state: 'working' },
  { key: 'planner', color: '#ec4899', label: 'Planning', eyes: 'open', fill: 52, state: 'idle' },
  { key: 'builder', color: '#14b8a6', label: 'Build', eyes: 'dead', fill: 91, state: 'broken' },
];

function buildTabs(args: AgentTabsArgs): HTMLElement {
  const frame = h('div', {
    style: `width:${args.width ?? 720}px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--canvas);`,
  });
  const tabs = document.createElement('slicc-agent-tabs') as SliccAgentTabs;
  tabs.scoops = args.scoops ?? BASE_ROSTER;
  tabs.active = args.active ?? 'cone';
  tabs.attention = args.attention ?? null;
  tabs.connection = args.connection ?? 'connected';
  frame.append(tabs);
  if (args.reducedMotion) {
    for (const arc of tabs.querySelectorAll<SVGElement>('.slicc-agent-tabs__glyph-arc')) {
      arc.style.animation = 'none';
      arc.style.transform = 'rotate(-90deg)';
    }
    for (const glow of tabs.querySelectorAll<SVGElement>('.slicc-agent-tabs__glyph-glow')) {
      glow.style.transition = 'none';
    }
  }
  if (args.overflowOpen) {
    requestAnimationFrame(() => {
      tabs.reflow();
      const overflow = tabs.querySelector('slicc-scoop-overflow');
      if (overflow) overflow.open = true;
    });
  }
  return frame;
}

function stateRoster(): ScoopDescriptor[] {
  const states: readonly AgentState[] = ['idle', 'working', 'broken', 'initializing'];
  return states.map((state, index) => ({
    key: state,
    label: state,
    color: ['#06b6d4', '#10b981', '#f43f5e', '#8b5cf6'][index],
    eyes: state === 'broken' ? 'dead' : state === 'initializing' ? 'none' : 'open',
    fill: [34, 62, 48, 20][index],
    state,
  }));
}

/** Both busy phases side by side, plus the unset default and a non-busy tab. */
function phaseRoster(): ScoopDescriptor[] {
  const busy = (
    key: string,
    label: string,
    color: string,
    phase?: AgentPhase
  ): ScoopDescriptor => ({
    key,
    label,
    color,
    phase,
    eyes: 'open',
    fill: 48,
    state: 'working',
  });
  return [
    busy('thinking', 'thinking', '#8b5cf6', 'thinking'),
    busy('tool', 'tool call', '#06b6d4', 'tool'),
    busy('unset', 'phase unset', '#10b981'),
    { key: 'idle', label: 'idle', color: '#f59e0b', eyes: 'open', fill: 30, state: 'idle' },
  ];
}

function fullnessRoster(): ScoopDescriptor[] {
  return [0, 25, 50, 75, 100].map((fill) => ({
    key: `fill-${fill}`,
    label: `${fill}%`,
    color: '#06b6d4',
    eyes: 'open',
    fill,
    state: 'working',
  }));
}

const meta: Meta<AgentTabsArgs> = {
  title: 'Switcher/AgentTabs',
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  render: buildTabs,
};

export default meta;
type Story = StoryObj<AgentTabsArgs>;

export const SingleCone: Story = {
  args: { scoops: [BASE_ROSTER[0]], active: 'cone', width: 720 },
};

export const Default: Story = { args: { scoops: BASE_ROSTER, active: 'cone', width: 720 } };

export const ConeMostRecent: Story = {
  args: { scoops: BASE_ROSTER, active: 'cone', attention: 'cone', width: 720 },
};

export const ScoopMostRecent: Story = {
  args: { scoops: BASE_ROSTER, active: 'cone', attention: 'designer', width: 720 },
};

export const WorkingAndMostRecent: Story = {
  args: {
    scoops: BASE_ROSTER.map((scoop) =>
      scoop.key === 'researcher' ? { ...scoop, state: undefined } : scoop
    ),
    active: 'cone',
    attention: 'researcher',
    width: 720,
  },
  parameters: {
    docs: {
      description: {
        story:
          'The rotating fullness arc still means working; its quiet static glow independently marks the most-recent speaker.',
      },
    },
  },
};

export const ConeFocused: Story = {
  args: { scoops: BASE_ROSTER, active: 'cone', width: 720 },
};

export const ScoopFocused: Story = {
  args: { scoops: BASE_ROSTER, active: 'researcher', width: 720 },
  play: async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    document.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: Math.max(900, window.innerWidth - 40),
        clientY: 40,
      })
    );
  },
};

export const EveryStatus: Story = {
  args: { scoops: stateRoster(), active: 'working', width: 620 },
};

export const BusyPhases: Story = {
  args: { scoops: phaseRoster(), active: 'thinking', width: 620 },
  parameters: {
    docs: {
      description: {
        story:
          'The centre pin carries what a working agent is busy with, borrowing the ' +
          'composer vocabulary: rectangular for the model thinking, circular for a ' +
          'tool call in flight. An unset phase reads as thinking, because a turn ' +
          'always opens in LLM-wait. Non-working agents show no pin at all.',
      },
    },
  },
};

export const Disconnected: Story = {
  args: {
    scoops: stateRoster(),
    active: 'broken',
    connection: 'disconnected',
    width: 620,
  },
  parameters: {
    docs: {
      description: {
        story: 'Connection trouble overrides the focused agent lifecycle with TV-static eyes.',
      },
    },
  },
};

export const FullnessLadder: Story = {
  args: { scoops: fullnessRoster(), active: 'fill-50', width: 620 },
};

export const Narrow360: Story = {
  args: { scoops: EXTRA_ROSTER, active: 'designer', width: 360 },
};

export const OverflowOpen: Story = {
  args: { scoops: EXTRA_ROSTER, active: 'designer', width: 360, overflowOpen: true },
};

export const ReducedMotion: Story = {
  args: {
    scoops: fullnessRoster(),
    active: 'fill-50',
    attention: 'fill-50',
    width: 620,
    reducedMotion: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Reduced motion parks the working arcs at 12 o’clock while preserving each fullness sweep.',
      },
    },
  },
};
