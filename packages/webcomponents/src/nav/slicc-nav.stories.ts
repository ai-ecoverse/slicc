import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-nav.js';
// Sibling controls composed in the bar — imported here so they self-register,
// which is what makes the story a realistic, fully-populated header (the nav
// composes them BY TAG and never imports them itself). The order is the bar's
// DOM (== layout) order: logo → switcher → spacer → floatbar → toggle → avatar.
import '../primitives/slicc-avatar.js';
import '../primitives/slicc-floatbar.js';
import '../primitives/slicc-logo.js';
import '../switcher/slicc-scoop-switcher.js';
import type { ScoopDescriptor } from '../switcher/slicc-scoop-switcher.js';
import '../theme/slicc-theme-toggle.js';

interface NavArgs {
  accent?: string;
}

/**
 * The prototype's standing scoops, cone-first (matches the proto nav row, with a
 * trailing ephemeral `triage` scoop). Each carries its own hue + eye state so the
 * switcher renders a row of distinct cone/scoop chips.
 */
const SCOOPS: ScoopDescriptor[] = [
  { key: 'cone', type: 'cone', color: '#b07823', label: 'Sliccy', eyes: 'open' },
  { key: 'researcher', type: 'scoop', color: '#06b6d4', label: 'researcher', eyes: 'none' },
  { key: 'designer', type: 'scoop', color: '#8b5cf6', label: 'designer', eyes: 'none' },
  { key: 'tester', type: 'scoop', color: '#f59e0b', label: 'tester', eyes: 'dead' },
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
 * Build a fully-populated nav bar that mirrors the prototype header, composed by
 * tag: logo → scoop switcher (cone active) → spacer → floatbar → theme toggle →
 * avatar. The switcher is fed its chips declaratively after connect so its reflow
 * has real geometry to measure (its overflow more-button rides along as a sibling
 * when the chips don't fit). The floatbar carries a live cost segment; the avatar
 * resolves a Gravatar from its `email` (initials show until the image loads).
 */
function makeNav(accent?: string): HTMLElement {
  const nav = document.createElement('slicc-nav');
  if (accent) nav.setAttribute('accent', accent);

  const logo = document.createElement('slicc-logo');
  logo.setAttribute('badge', 'beta');

  const switcher = document.createElement('slicc-scoop-switcher');
  switcher.setAttribute('active', 'cone');
  // Populate after connect so the switcher's reflow has real chips to measure.
  queueMicrotask(() => {
    (switcher as unknown as { scoops: ScoopDescriptor[] }).scoops = SCOOPS;
    switcher.setAttribute('active', 'cone');
  });

  const floatbar = document.createElement('slicc-floatbar');
  floatbar.setAttribute('label', 'CLI · tray · 1 follower');
  floatbar.setAttribute('spent', '$2.41');
  floatbar.setAttribute('linked', '');
  floatbar.setAttribute('online', '');

  const toggle = document.createElement('slicc-theme-toggle');

  const avatar = document.createElement('slicc-avatar');
  // An `email` resolves to a Gravatar (initials show until the image loads).
  avatar.setAttribute('email', 'beau@dodds.net');
  avatar.setAttribute('name', 'Beau Dodds');

  // DOM order is the layout order; the nav auto-inserts the flexible spacer
  // before the floatbar so the trailing controls pin to the right edge.
  nav.append(logo, switcher, floatbar, toggle, avatar);
  return nav;
}

/**
 * Mount the bar in a realistic full-width app frame over a faux app background
 * (`var(--bg)`), so the frosted, context-tinted header reads against real chrome
 * — exactly how it sits atop the chat shell in the prototype's `.app`. The frame
 * width is the tunable that drives the switcher's overflow behavior across the
 * Default / Wide / Narrow stories.
 */
function appFrame(nav: HTMLElement, width: string): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText = `display:flex;flex-direction:column;width:${width};max-width:100%;height:300px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);font-family:var(--ui);`;

  // Faux app body beneath the nav, so the bar is reviewed in context (not floating).
  const body = document.createElement('div');
  body.style.cssText =
    'flex:1;min-height:0;display:grid;place-items:center;color:var(--txt-3);font-size:13px;background:var(--bg);';
  body.textContent = 'chat shell';

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

/**
 * The header the review is about: a fully-populated bar — logo (with a rainbow
 * `beta` badge), the cone + four scoops switcher (cone active), a linked CLI
 * floatbar showing `$2.41` spent, the theme toggle, and a Gravatar avatar — over
 * a faux app background at a comfortable 980px. Flip the global theme toolbar for
 * light/dark; the frosted tint recomputes from `--canvas` / `--ctx` with no dark
 * override of its own.
 */
export const Default: Story = { args: {} };

/**
 * Wide frame (1280px): every scoop chip fits inline, so the switcher's overflow
 * more-button stays away and the whole row is visible. The right-aligned cluster
 * still pins to the edge via the auto-inserted spacer.
 */
export const Wide: Story = {
  render: ({ accent }) => appFrame(makeNav(accent), '1280px'),
};

/**
 * Narrow frame (560px): the chips no longer fit, so the switcher collapses the
 * trailing scoops into its `<slicc-scoop-overflow>` more-popup (the cone chip is
 * never hidden). The floatbar, toggle, and avatar still hold the right edge —
 * the interesting overflow state to review.
 */
export const Narrow: Story = {
  render: ({ accent }) => appFrame(makeNav(accent), '560px'),
};

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
    floatbar.setAttribute('spent', '$0.18');
    floatbar.setAttribute('online', '');
    const avatar = document.createElement('slicc-avatar');
    avatar.setAttribute('name', 'Lars Trieloff');
    nav.append(logo, floatbar, avatar);
    return appFrame(nav, '720px');
  },
};
