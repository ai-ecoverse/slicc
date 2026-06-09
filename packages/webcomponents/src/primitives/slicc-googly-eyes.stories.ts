import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-googly-eyes.js';

interface GooglyEyesArgs {
  inverted?: boolean;
  tracking?: boolean;
  eyes?: 'open' | 'dead';
  size?: number;
}

const meta: Meta<GooglyEyesArgs> = {
  title: 'Primitives/GooglyEyes',
  component: 'slicc-googly-eyes',
  tags: ['autodocs'],
  argTypes: {
    inverted: { control: 'boolean', description: 'White border + white pupil variant' },
    tracking: { control: 'boolean', description: 'Pupils follow the cursor (default on)' },
    eyes: { control: 'inline-radio', options: ['open', 'dead'], description: 'Eye state' },
    size: {
      control: { type: 'number', min: 9, max: 96, step: 1 },
      description: 'Eye diameter (px)',
    },
  },
  render: ({ inverted, tracking, eyes, size }) => {
    const el = document.createElement('slicc-googly-eyes');
    if (inverted) el.setAttribute('inverted', '');
    if (tracking === false) el.setAttribute('tracking', 'off');
    if (eyes) el.setAttribute('eyes', eyes);
    if (size != null) el.setAttribute('size', String(size));
    return el;
  },
};

export default meta;
type Story = StoryObj<GooglyEyesArgs>;

/** Default: black pupils on white, tracking the cursor. Move the mouse to wiggle. */
export const Default: Story = { args: {} };

/** Inverted: white border + white pupil, for dark/active chrome. */
export const Inverted: Story = { args: { inverted: true } };

/** Tracking explicitly enabled (the default) — pupils follow the pointer. */
export const Tracking: Story = { args: { tracking: true } };

/** Idle: tracking off, pupils centred. */
export const Idle: Story = { args: { tracking: false } };

/** Dead: the "X X" state used for finished/failed scoops. */
export const Dead: Story = { args: { eyes: 'dead' } };

/** Enlarged so the pupil-tracking geometry is easy to see. */
export const Large: Story = { args: { size: 64 } };
