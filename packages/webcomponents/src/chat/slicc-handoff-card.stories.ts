import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../primitives/slicc-googly-eyes.js';
import './slicc-handoff-card.js';

interface HandoffArgs {
  variant?: 'handoff' | 'opened';
  name?: string;
  pre?: string;
  text?: string;
  eyes?: 'open' | 'dead';
}

const meta: Meta<HandoffArgs> = {
  title: 'Chat/HandoffCard',
  component: 'slicc-handoff-card',
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['handoff', 'opened'],
      description: 'Which card to render',
    },
    name: { control: 'text', description: 'Violet bold name (handoff) / bold target (opened)' },
    pre: { control: 'text', description: 'Muted label prefix (handoff variant)' },
    text: { control: 'text', description: 'Body paragraph / receipt suffix' },
    eyes: {
      control: 'inline-radio',
      options: ['open', 'dead'],
      description: "Forwarded to the avatar's googly eyes",
    },
  },
  render: ({ variant, name, pre, text, eyes }) => {
    const el = document.createElement('slicc-handoff-card');
    if (variant) el.setAttribute('variant', variant);
    if (name) el.setAttribute('name', name);
    if (pre) el.setAttribute('pre', pre);
    if (text) el.setAttribute('text', text);
    if (eyes) el.setAttribute('eyes', eyes);
    el.style.maxWidth = '680px';
    return el;
  },
};

export default meta;
type Story = StoryObj<HandoffArgs>;

export const Handoff: Story = {
  args: {
    variant: 'handoff',
    pre: 'Handoff request from',
    name: 'acme.com',
    text: 'Continue work in the SLICC browser agent. Approve to let sliccy pick up this session and run with it.',
  },
};

export const Opened: Story = {
  args: {
    variant: 'opened',
    name: 'Hero studio',
    text: '· opened a sprinkle in the workbench',
  },
};

export const OpenedBare: Story = {
  args: {
    variant: 'opened',
    name: 'palette.shtml',
  },
};

export const HandoffDeadEyes: Story = {
  args: {
    variant: 'handoff',
    pre: 'Handoff request from',
    name: 'staging.acme.com',
    text: 'This handoff was declined — the session stays on the host page.',
    eyes: 'dead',
  },
};

export const Gallery: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '4px';
    wrap.style.maxWidth = '680px';

    const handoff = document.createElement('slicc-handoff-card');
    handoff.setAttribute('variant', 'handoff');
    handoff.setAttribute('pre', 'Handoff request from');
    handoff.setAttribute('name', 'acme.com');
    handoff.setAttribute(
      'text',
      'Continue work in the SLICC browser agent. Approve to let sliccy pick up this session.'
    );

    const opened = document.createElement('slicc-handoff-card');
    opened.setAttribute('variant', 'opened');
    opened.setAttribute('name', 'Hero studio');
    opened.setAttribute('text', '· opened a sprinkle in the workbench');

    wrap.append(handoff, opened);
    return wrap;
  },
};
