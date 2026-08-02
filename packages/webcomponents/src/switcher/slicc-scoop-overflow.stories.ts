import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h } from '../internal/dom.js';
import type { SliccScoopOverflow, SliccScoopOverflowItem } from './slicc-scoop-overflow.js';
import './slicc-scoop-overflow.js';

interface OverflowArgs {
  /** The overflowed scoop descriptors fed into the popup. */
  items?: SliccScoopOverflowItem[];
  /** Open the popup after mount. */
  open?: boolean;
}

/** A realistic set of overflowed scoops, colored by the prototype's hues. */
const SCOOPS: SliccScoopOverflowItem[] = [
  { id: 'researcher', label: 'researcher', color: '#06b6d4', state: 'working', fill: 42 },
  { id: 'designer', label: 'designer', color: '#8b5cf6', state: 'idle', fill: 18 },
  { id: 'tester', label: 'tester', color: '#f59e0b', state: 'broken', fill: 90 },
  { id: 'triage', label: 'triage', color: '#168a35', state: 'initializing', fill: 78 },
];

/**
 * Mount inside a faux nav band with a couple of visible header segments to the
 * left, so the status-grid trigger + dropdown read in their real context (matching the
 * prototype's `.switcher` / `.switcher-more` layout).
 */
function buildOverflow({ items = SCOOPS, open }: OverflowArgs): HTMLElement {
  const nav = document.createElement('div');
  nav.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:7px 14px;height:44px;' +
    'background:var(--canvas);border:1px solid var(--line);border-radius:12px;' +
    'font-family:var(--ui);width:min-content;';

  // Two visible segments anchor the overflow trigger beside the popup's vertical rows.
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

/** Has overflow, closed — the fixed status-coded 3×3 trigger is visible. */
export const HasOverflowClosed: Story = { args: {} };

/**
 * Open — the overflowed scoops stack column-wise, full width, directly beneath
 * the trigger with no frame/background chrome. They reveal with a per-item
 * stagger (organic entrance), suppressed under `prefers-reduced-motion`.
 */
export const Open: Story = { args: { open: true } };

/** No overflow — `items` is empty so the trigger is hidden entirely. */
export const Hidden: Story = { args: { items: [] } };

/** A single overflowed scoop. */
export const SingleItem: Story = {
  args: {
    open: true,
    items: [{ id: 'designer', label: 'designer', color: '#8b5cf6', state: 'idle', fill: 18 }],
  },
};

/** A long overflow list demonstrating the vertical stacking. */
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

/** Above nine hidden scoops, severity sorting preserves eight dots and reserves cell 9 for +. */
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

/** Dark theme — popup surfaces flip via the inherited `.dark` scope. */
export const Dark: Story = {
  args: { open: true },
  globals: { theme: 'dark' },
};

/**
 * Narrow / mobile viewport — the popup keeps the same full-width vertical rows,
 * including each status glyph, label, and state/fullness readout.
 */
export const Narrow: Story = {
  args: { open: true },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
