import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-nav.js';
// Sibling controls composed in the bar — already registered; importing them
// makes the Storybook example a realistic, populated header (not empty tags).
import '../primitives/slicc-avatar.js';
import '../primitives/slicc-floatbar.js';
import '../primitives/slicc-logo.js';
import '../switcher/slicc-scoop-switcher.js';
import type { ScoopDescriptor } from '../switcher/slicc-scoop-switcher.js';
import '../theme/slicc-theme-toggle.js';

interface NavArgs {
  accent?: string;
}

/** The prototype's four standing scoops, cone-first (matches the proto nav). */
const SCOOPS: ScoopDescriptor[] = [
  { key: 'cone', type: 'cone', color: '#b07823', label: 'Sliccy', eyes: 'open' },
  { key: 'researcher', type: 'scoop', color: '#06b6d4', label: 'researcher', eyes: 'none' },
  { key: 'designer', type: 'scoop', color: '#8b5cf6', label: 'designer', eyes: 'none' },
  { key: 'tester', type: 'scoop', color: '#f59e0b', label: 'tester', eyes: 'dead' },
];

/**
 * Build a fully-populated nav bar that mirrors the prototype header: logo →
 * scoop switcher (cone active) → spacer → floatbar → theme toggle → avatar.
 * The switcher is fed declaratively; its overflow more-button rides along as a
 * sibling when the chips don't fit.
 */
function makeNav(accent?: string): HTMLElement {
  const nav = document.createElement('slicc-nav');
  if (accent) nav.setAttribute('accent', accent);

  const logo = document.createElement('slicc-logo');

  const switcher = document.createElement('slicc-scoop-switcher');
  switcher.setAttribute('active', 'cone');
  // Populate after connect so the switcher's reflow has real chips to measure.
  queueMicrotask(() => {
    (switcher as unknown as { scoops: ScoopDescriptor[] }).scoops = SCOOPS;
    switcher.setAttribute('active', 'cone');
  });

  const floatbar = document.createElement('slicc-floatbar');
  floatbar.setAttribute('label', 'CLI · tray · 1 follower');
  floatbar.setAttribute('linked', '');
  floatbar.setAttribute('online', '');

  const toggle = document.createElement('slicc-theme-toggle');

  const avatar = document.createElement('slicc-avatar');
  avatar.setAttribute('initials', 'PM');

  // DOM order is the layout order; the nav auto-inserts the flexible spacer
  // before the floatbar so the trailing controls pin to the right edge.
  nav.append(logo, switcher, floatbar, toggle, avatar);
  return nav;
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
  render: ({ accent }) => makeNav(accent),
};

export default meta;
type Story = StoryObj<NavArgs>;

/** Default bar — no `accent`, so the frosted tint uses the inherited `--ctx`. */
export const Default: Story = { args: {} };

/** Context-tinted: amber `--ctx` (the prototype's default cone context). */
export const AmberContext: Story = { args: { accent: '#f59e0b' } };

/** Context-tinted: cyan `--ctx` — the researcher scoop's hue. */
export const CyanContext: Story = { args: { accent: '#06b6d4' } };

/** Context-tinted: violet `--ctx` — the designer scoop's hue. */
export const VioletContext: Story = { args: { accent: '#8b5cf6' } };

/** Context-tinted: rose `--ctx` — a one-shot / ephemeral scoop context. */
export const RoseContext: Story = { args: { accent: '#f43f5e' } };

/**
 * Minimal markup: only an `accent` + a couple of right-aligned controls — the
 * nav still auto-inserts the flexible spacer so the floatbar / avatar pin right.
 */
export const MinimalAutoSpacer: Story = {
  render: () => {
    const nav = document.createElement('slicc-nav');
    nav.setAttribute('accent', '#10b981');
    const logo = document.createElement('slicc-logo');
    const floatbar = document.createElement('slicc-floatbar');
    floatbar.setAttribute('label', 'cloud · hosted leader');
    floatbar.setAttribute('online', '');
    const avatar = document.createElement('slicc-avatar');
    avatar.setAttribute('name', 'Lars Trieloff');
    nav.append(logo, floatbar, avatar);
    return nav;
  },
};
