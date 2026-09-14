import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-freezer.js';

import './slicc-freezer-card.js';
import './slicc-freezer-new.js';
import './slicc-frost-shader.js';

interface FreezerArgs {
  open?: boolean;
  ctx?: boolean;
  frost?: boolean;
}

interface CardSpec {
  title: string;
  meta: string;
  slug: string;
}

const SESSIONS: CardSpec[] = [
  { title: 'warm hero redesign', meta: '2h ago · 18 turns · PR #128', slug: 'warm-hero' },
  { title: 'checkout funnel audit', meta: 'yesterday · 11 turns · 4 scoops', slug: 'checkout' },
  { title: 'dark-mode polish', meta: '3d ago · 7 turns · PR #119', slug: 'dark-mode' },
  { title: 'onboarding rewrite', meta: 'last week · 24 turns · LIN-401', slug: 'onboarding' },
  { title: 'mobile nav refresh', meta: '2 weeks ago · 9 turns · PR #114', slug: 'mobile-nav' },
  { title: 'pricing table revamp', meta: '3 weeks ago · 15 turns · PR #109', slug: 'pricing' },
  { title: 'search ux audit', meta: 'last month · 6 turns · LIN-388', slug: 'search-ux' },
  { title: 'error states pass', meta: '2 months ago · 12 turns · PR #95', slug: 'errors' },
  { title: 'analytics dashboard', meta: '2 months ago · 21 turns · PR #88', slug: 'analytics' },
];

function makeNew(): HTMLElement {
  return document.createElement('slicc-freezer-new');
}

function makeCard(spec: CardSpec): HTMLElement {
  const el = document.createElement('slicc-freezer-card');
  el.setAttribute('title', spec.title);
  el.setAttribute('meta', spec.meta);
  el.setAttribute('slug', spec.slug);
  return el;
}

function buildFreezer({ open, ctx }: FreezerArgs): HTMLElement {
  const el = document.createElement('slicc-freezer');
  if (open) el.setAttribute('open', '');
  if (ctx) el.setAttribute('ctx', '');
  el.append(makeNew());
  for (const spec of SESSIONS) el.append(makeCard(spec));
  return el;
}

function frostBehind(open: boolean): HTMLElement {
  const frost = document.createElement('slicc-frost-shader');
  frost.setAttribute('coverage', '0.7');
  frost.style.cssText = `position:fixed;left:0;top:0;bottom:0;width:${
    open ? '260px' : '44px'
  };z-index:0;`;
  return frost;
}

const meta: Meta<FreezerArgs> = {
  title: 'Freezer/Rail',
  component: 'slicc-freezer',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Expand the rail (260px) vs collapsed (44px)' },
    ctx: { control: 'boolean', description: 'Ice-blue accent while a freezer context is active' },
    frost: { control: 'boolean', description: 'Lay a <slicc-frost-shader> ice background behind' },
  },

  decorators: [
    (story) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;min-height:560px;';
      wrap.appendChild(story() as HTMLElement);
      return wrap;
    },
  ],
  render: (args) => {
    const stage = document.createDocumentFragment();
    if (args.frost) stage.appendChild(frostBehind(Boolean(args.open)));
    stage.appendChild(buildFreezer(args));

    const host = document.createElement('div');
    host.appendChild(stage);
    return host;
  },
};

export default meta;
type Story = StoryObj<FreezerArgs>;

export const Collapsed: Story = { args: { open: false, frost: true } };

export const Open: Story = { args: { open: true, frost: true } };

export const FreezerContext: Story = { args: { open: true, ctx: true, frost: true } };

export const CollapsedContext: Story = { args: { open: false, ctx: true, frost: true } };
