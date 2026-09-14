import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../primitives/slicc-avatar.js';
import type { AvatarMenuItem, AvatarMenuUser, SliccAvatarMenu } from './slicc-avatar-menu.js';
import './slicc-avatar-menu.js';

const meta: Meta = {
  title: 'Nav/Avatar Menu',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

const USER: AvatarMenuUser = { name: 'Lars Trieloff', provider: 'Anthropic' };

const FULL: AvatarMenuItem[] = [
  { id: 'sync', label: 'Enable multi-browser sync', icon: 'radio' },
  { kind: 'caption', label: 'Lend this browser to another as a follower.' },
  { kind: 'separator' },
  { id: 'new-session', label: 'New session', icon: 'plus' },
  { id: 'settings', label: 'Account settings…', icon: 'settings' },
  { kind: 'separator' },
  { id: 'signout', label: 'Sign out', icon: 'log-out', danger: true },
];

function menu(opts: {
  open?: boolean;
  user?: AvatarMenuUser | null;
  items?: AvatarMenuItem[];
}): SliccAvatarMenu {
  const el = document.createElement('slicc-avatar-menu') as SliccAvatarMenu;
  if (opts.open) el.setAttribute('open', '');
  const avatar = document.createElement('slicc-avatar');
  avatar.setAttribute('email', 'beau@dodds.net');
  avatar.setAttribute('name', 'Lars Trieloff');
  el.append(avatar);
  el.user = opts.user ?? USER;
  el.items = opts.items ?? FULL;

  const frame = document.createElement('div');
  frame.style.cssText =
    'min-height:340px;display:flex;justify-content:center;align-items:flex-start;padding-top:16px;';
  frame.append(el);
  return frame as unknown as SliccAvatarMenu;
}

export const Closed: Story = { render: () => menu({ open: false }) };

export const Open: Story = { render: () => menu({ open: true }) };

export const FollowerState: Story = {
  render: () =>
    menu({
      open: true,
      user: { name: 'beau@dodds.net', provider: 'Following leader' },
      items: [
        { id: 'status', label: 'Connected as follower', disabled: true },
        { kind: 'caption', label: 'This browser is lent to a remote leader.' },
        { kind: 'separator' },
        { id: 'disconnect', label: 'Disconnect from leader', icon: 'unplug', danger: true },
      ],
    }),
};

export const SignedOut: Story = {
  render: () =>
    menu({
      open: true,
      user: null,
      items: [
        { id: 'signin', label: 'Sign in', icon: 'log-in' },
        { id: 'settings', label: 'Account settings…', icon: 'settings' },
      ],
    }),
};
