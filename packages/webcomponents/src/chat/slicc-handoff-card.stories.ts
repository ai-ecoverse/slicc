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

/** The handoff approval card: violet avatar + label over a body paragraph. */
export const Handoff: Story = {
  args: {
    variant: 'handoff',
    pre: 'Handoff request from',
    name: 'acme.com',
    text: 'Continue work in the SLICC browser agent. Approve to let sliccy pick up this session and run with it.',
  },
};

/**
 * The opened receipt: a lucide **sparkles** glyph chip (rainbow ground) + bold
 * target text on a ghost ground. The chip glyph is an `<svg>`, never an emoji.
 */
export const Opened: Story = {
  args: {
    variant: 'opened',
    name: 'Hero studio',
    text: '· opened a sprinkle in the workbench',
  },
};

/**
 * The opened receipt with only a bold target and no trailing text — the
 * tightest form of the sparkles chip pill.
 */
export const OpenedBare: Story = {
  args: {
    variant: 'opened',
    name: 'palette.shtml',
  },
};

/** Handoff card with dead eyes — the paused / declined avatar state. */
export const HandoffDeadEyes: Story = {
  args: {
    variant: 'handoff',
    pre: 'Handoff request from',
    name: 'staging.acme.com',
    text: 'This handoff was declined — the session stays on the host page.',
    eyes: 'dead',
  },
};

/**
 * Both variants stacked, so the sparkles glyph chip can be reviewed against the
 * violet googly-eyes avatar in one frame (toggle the theme + viewport toolbars).
 */
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
