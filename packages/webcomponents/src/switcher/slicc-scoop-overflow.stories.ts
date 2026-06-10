import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../pill/slicc-pill.js';
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
  { id: 'researcher', label: 'researcher', color: '#06b6d4' },
  { id: 'designer', label: 'designer', color: '#8b5cf6' },
  { id: 'tester', label: 'tester', color: '#f59e0b' },
  { id: 'triage', label: 'triage', color: '#168a35' },
];

/**
 * Mount inside a faux nav band with a couple of visible header chips to the
 * left, so the "⋯" trigger + dropdown read in their real context (matching the
 * prototype's `.switcher` / `.switcher-more` layout).
 */
function buildOverflow({ items = SCOOPS, open }: OverflowArgs): HTMLElement {
  const nav = document.createElement('div');
  nav.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:7px 14px;height:44px;' +
    'background:var(--canvas);border:1px solid var(--line);border-radius:12px;' +
    'font-family:var(--ui);width:min-content;';

  // Two visible header chips to anchor the overflow trigger beside them.
  for (const s of [
    { id: 'cone', label: 'sliccy', type: 'cone' as const, color: '#b07823', active: true },
    { id: 'researcher', label: 'researcher', color: '#06b6d4' },
  ]) {
    const pill = document.createElement('slicc-pill');
    pill.setAttribute('type', s.type ?? 'scoop');
    pill.setAttribute('label', s.label);
    pill.setAttribute('eyes', 'none');
    if (s.color) pill.setAttribute('color', s.color);
    if (s.active) pill.setAttribute('active', '');
    nav.appendChild(pill);
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

/** Has overflow, closed — only the pill-shaped "⋯" trigger is visible. */
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
  args: { open: true, items: [{ id: 'designer', label: 'designer', color: '#8b5cf6' }] },
};

/** A long overflow list demonstrating the vertical stacking. */
export const ManyItems: Story = {
  args: {
    open: true,
    items: [
      ...SCOOPS,
      { id: 'writer', label: 'writer', color: '#f43f5e' },
      { id: 'reviewer', label: 'reviewer', color: '#06b6d4', eyes: 'dead' },
    ],
  },
};

/** Dark theme — popup surfaces flip via the inherited `.dark` scope. */
export const Dark: Story = {
  args: { open: true },
  globals: { theme: 'dark' },
};
