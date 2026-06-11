import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../pill/slicc-pill.js';
// Compose the overflow popup BY TAG — importing its side-effect module so the
// "⋯" dropdown upgrades and renders in Storybook (the switcher creates it lazily).
import './slicc-scoop-overflow.js';
import type { ScoopDescriptor, SliccScoopSwitcher } from './slicc-scoop-switcher.js';
import './slicc-scoop-switcher.js';

interface SwitcherArgs {
  /** The scoop list (cone first). */
  scoops?: ScoopDescriptor[];
  /** Active chip key. */
  active?: string;
  /** Chip wearing the (blinking) eyes when nothing is hovered. */
  attention?: string;
  /** Width of the surrounding nav band (drives the overflow reflow). */
  width?: number;
}

/** The prototype's default scoop roster: cone first, then four colored scoops. */
const SCOOPS: ScoopDescriptor[] = [
  { key: 'cone', type: 'cone', color: '#b07823', label: 'Sliccy', eyes: 'open' },
  // Ready scoops carry eyes:'open' (matching the live host's status mapping);
  // the switcher's one-pair rule decides who actually wears them.
  { key: 'researcher', type: 'scoop', color: '#06b6d4', label: 'researcher', eyes: 'open' },
  { key: 'designer', type: 'scoop', color: '#8b5cf6', label: 'designer', eyes: 'open' },
  { key: 'tester', type: 'scoop', color: '#f59e0b', label: 'tester', eyes: 'dead' },
];

/** The full roster including a green `triage` ephemeral chip. */
const SCOOPS_WITH_EPHEMERAL: ScoopDescriptor[] = [
  ...SCOOPS,
  {
    key: 'triage',
    type: 'scoop',
    color: '#10b981',
    label: 'triage',
    eyes: 'none',
    ephemeral: true,
  },
];

/**
 * Mount the switcher inside a faux nav band so the `.switcher` row, the active
 * fill, and (when the band is narrow) the overflow `⋯` popup read in their real
 * prototype context.
 */
function buildSwitcher({
  scoops = SCOOPS,
  active = 'cone',
  attention = 'cone',
  width,
}: SwitcherArgs): HTMLElement {
  const nav = document.createElement('div');
  nav.style.cssText =
    'display:flex;align-items:center;gap:14px;padding:0 16px;height:44px;' +
    'background:var(--canvas);border:1px solid var(--line);border-radius:12px;' +
    `font-family:var(--ui);box-sizing:border-box;${width ? `width:${width}px;` : 'width:min-content;'}`;

  const logo = document.createElement('span');
  logo.textContent = 'sliccy';
  logo.style.cssText = 'font-weight:600;font-size:14px;letter-spacing:-.02em;flex:0 0 auto;';
  nav.appendChild(logo);

  const switcher = document.createElement('slicc-scoop-switcher') as SliccScoopSwitcher;
  switcher.style.marginLeft = '0';
  switcher.scoops = scoops;
  if (active) switcher.active = active;
  if (attention) switcher.attention = attention;
  nav.appendChild(switcher);

  // The spacer absorbs free width so the switcher row is content-sized (matches
  // the prototype `.nav .spacer{flex:1}`); without a fixed nav width it lets the
  // chips sit at their natural size.
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  nav.appendChild(spacer);

  return nav;
}

const meta: Meta<SwitcherArgs> = {
  title: 'Switcher/ScoopSwitcher',
  tags: ['autodocs'],
  argTypes: {
    active: {
      control: 'inline-radio',
      options: ['cone', 'researcher', 'designer', 'tester', 'triage'],
      description: 'Active chip key',
    },
    width: {
      control: { type: 'number', min: 240, max: 900, step: 20 },
      description: 'Nav band width (narrow → overflow popup)',
    },
  },
  render: buildSwitcher,
};

export default meta;
type Story = StoryObj<SwitcherArgs>;

/** The default roster — cone active, four chips, all fitting. */
export const Default: Story = { args: { scoops: SCOOPS, active: 'cone' } };

/** A scoop chip is active (accent fills the pill, white label). */
export const ScoopActive: Story = { args: { scoops: SCOOPS, active: 'researcher' } };

/** The tester scoop ran into trouble — dead "X X" eyes (shown on its turn). */
export const DeadScoop: Story = { args: { scoops: SCOOPS, active: 'cone', attention: 'tester' } };

/**
 * Eyes are one-pair-at-a-time: the `attention` chip (most recent agent message
 * or user input, host-fed) wears them blinking; hovering any chip moves the
 * pair there with a steady gaze.
 */
export const AttentionEyes: Story = {
  args: { scoops: SCOOPS, active: 'cone', attention: 'researcher' },
};

/** Includes a green ephemeral `triage` chip auto-spawned by a lick. */
export const WithEphemeral: Story = {
  args: { scoops: SCOOPS_WITH_EPHEMERAL, active: 'cone' },
};

/**
 * Narrow nav band: the chips don't all fit, so the reflow hides the trailing
 * ones into the `⋯` overflow popup (the cone is never hidden). Click `⋯` to open.
 */
export const Overflow: Story = {
  args: { scoops: SCOOPS_WITH_EPHEMERAL, active: 'cone', width: 360 },
};

/** Very tight band — only the cone survives; everything else collapses. */
export const HeavyOverflow: Story = {
  args: { scoops: SCOOPS_WITH_EPHEMERAL, active: 'cone', width: 280 },
};
