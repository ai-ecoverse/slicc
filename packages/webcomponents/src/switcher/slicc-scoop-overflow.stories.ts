import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h } from '../internal/dom.js';
import type { SliccScoopOverflow, SliccScoopOverflowItem } from './slicc-scoop-overflow.js';
import './slicc-scoop-overflow.js';

interface OverflowArgs {
  items?: SliccScoopOverflowItem[];

  open?: boolean;
}

const SCOOPS: SliccScoopOverflowItem[] = [
  { id: 'researcher', label: 'researcher', color: '#06b6d4', state: 'working', fill: 42 },
  { id: 'designer', label: 'designer', color: '#8b5cf6', state: 'idle', fill: 18 },
  { id: 'tester', label: 'tester', color: '#f59e0b', state: 'broken', fill: 90 },
  { id: 'triage', label: 'triage', color: '#168a35', state: 'initializing', fill: 78 },
];

function buildOverflow({ items = SCOOPS, open }: OverflowArgs): HTMLElement {
  const nav = document.createElement('div');
  nav.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:7px 14px;height:44px;' +
    'background:var(--canvas);border:1px solid var(--line);border-radius:12px;' +
    'font-family:var(--ui);width:min-content;';

  for (const s of [
    { id: 'cone', label: 'sliccy', color: '#b07823', active: true },
    { id: 'researcher', label: 'researcher', color: '#06b6d4' },
  ]) {
    nav.append(
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(Boolean(s.active)),
          style:
            'display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;' +
            'color:var(--txt-2);font:500 11px/1 var(--ui);border:0;border-radius:6px;' +
            `background:${s.active ? 'var(--ghost)' : 'transparent'}`,
        },
        h('span', {
          'aria-hidden': 'true',
          style: `width:7px;height:7px;border-radius:50%;background:${s.color}`,
        }),
        s.label
      )
    );
  }

  const el = document.createElement('slicc-scoop-overflow') as SliccScoopOverflow;
  el.items = items;
  nav.appendChild(el);

  if (open) requestAnimationFrame(() => el.show());
  return nav;
}

const meta: Meta<OverflowArgs> = {
  title: 'Switcher/ScoopOverflow',
  component: 'slicc-scoop-overflow',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Open the overflow popup on mount' },
  },
  render: (args) => buildOverflow(args),
};

export default meta;
type Story = StoryObj<OverflowArgs>;

export const HasOverflowClosed: Story = { args: {} };

export const Open: Story = { args: { open: true } };

export const Hidden: Story = { args: { items: [] } };

export const SingleItem: Story = {
  args: {
    open: true,
    items: [{ id: 'designer', label: 'designer', color: '#8b5cf6', state: 'idle', fill: 18 }],
  },
};

export const ManyItems: Story = {
  args: {
    open: true,
    items: [
      ...SCOOPS,
      { id: 'writer', label: 'writer', color: '#f43f5e', state: 'working', fill: 25 },
      {
        id: 'reviewer',
        label: 'reviewer',
        color: '#06b6d4',
        eyes: 'dead',
        state: 'broken',
        fill: 66,
      },
    ],
  },
};

export const MoreThanNine: Story = {
  args: {
    open: true,
    items: [
      ...SCOOPS,
      { id: 'writer', state: 'working', fill: 34 },
      { id: 'reviewer', state: 'idle', fill: 12 },
      { id: 'planner', state: 'initializing', fill: 2 },
      { id: 'builder', state: 'working', fill: 81 },
      { id: 'analyst', state: 'idle', fill: 9 },
      { id: 'editor', state: 'broken', fill: 88 },
    ],
  },
};

export const Unread: Story = {
  args: {
    open: true,
    items: SCOOPS.map((item, index) => (index % 2 === 0 ? { ...item, unread: index + 2 } : item)),
  },
};

export const UnreadClosed: Story = {
  args: { items: SCOOPS.map((item) => ({ ...item, unread: 3 })) },
};

export const Dark: Story = {
  args: { open: true },
  globals: { theme: 'dark' },
};

export const Narrow: Story = {
  args: { open: true },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
