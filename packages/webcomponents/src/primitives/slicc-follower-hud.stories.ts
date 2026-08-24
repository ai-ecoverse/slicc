import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-floatbar.js';
import './slicc-follower-hud.js';
import type { SliccFloatbar } from './slicc-floatbar.js';
import type { FollowerHudRow } from './slicc-follower-hud.js';

const meta: Meta = {
  title: 'Primitives/FollowerHud',
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj;

/** One of each follower kind the leader can actually see. */
const allKinds = (): FollowerHudRow[] => [
  {
    id: 'follower-ios1',
    icon: 'smartphone',
    title: 'iOS · a1b2c3d4…',
    detail: 'iPhone 15 Pro · Sliccy 6.71',
    state: 'active',
    stateText: 'connected 4m',
  },
  {
    id: 'follower-cli1',
    icon: 'terminal',
    title: 'CLI · build-box',
    detail: 'slicc-cli exec target · lars@build-box · darwin/arm64 · runner: bash -c',
    state: 'active',
    stateText: 'connected 2h',
    chips: ['can run commands'],
  },
  {
    id: 'follower-tab1',
    icon: 'monitor',
    title: 'Standalone · 9f8e7d6c…',
    detail: 'slicc-standalone',
    state: 'active',
    stateText: 'connected 31s',
    chips: ['hosts tabs'],
  },
  {
    id: 'follower-ext1',
    icon: 'blocks',
    title: 'Extension · 5b4a3928…',
    detail: 'slicc-extension',
    state: 'warn',
    stateText: 'stalled 12m',
  },
];

function anchored(build: (host: HTMLElement) => void): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'position: relative; display: inline-block; margin: 24px 24px 260px 160px;';
  build(wrapper);
  return wrapper;
}

/** The card on its own, always open. */
export const Standalone: Story = {
  render: () =>
    anchored((wrapper) => {
      const hud = document.createElement('slicc-follower-hud');
      hud.rows = allKinds();
      hud.hint = 'Click for sharing options.';
      hud.open = true;
      wrapper.appendChild(hud);
    }),
};

/** A single follower — the common case right after pairing a phone. */
export const SingleFollower: Story = {
  render: () =>
    anchored((wrapper) => {
      const hud = document.createElement('slicc-follower-hud');
      hud.rows = [allKinds()[0]];
      hud.open = true;
      wrapper.appendChild(hud);
    }),
};

/** Nothing attached — the empty state the floatbar never actually shows. */
export const Empty: Story = {
  render: () =>
    anchored((wrapper) => {
      const hud = document.createElement('slicc-follower-hud');
      hud.rows = [];
      hud.open = true;
      wrapper.appendChild(hud);
    }),
};

/** The live pairing: hover (or tab to) the followers segment in the pill. */
export const FloatbarWithFollowers: Story = {
  render: () => {
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'display: flex; justify-content: flex-end; padding: 16px; margin-bottom: 280px;';
    const floatbar = document.createElement('slicc-floatbar') as SliccFloatbar;
    floatbar.label = 'npx';
    floatbar.floatKind = 'npx';
    floatbar.connection = 'live';
    floatbar.trayRole = 'leader';
    floatbar.rate = '23.10';
    floatbar.followers = allKinds();
    wrapper.appendChild(floatbar);
    return wrapper;
  },
};
