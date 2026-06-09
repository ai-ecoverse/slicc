import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-googly-eyes.js';

interface GooglyEyesArgs {
  inverted?: boolean;
  tracking?: boolean;
  blink?: boolean;
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
    blink: {
      control: 'boolean',
      description: 'Periodic eyelid blink (CSS scaleY; no-op under reduced-motion / dead)',
    },
    eyes: { control: 'inline-radio', options: ['open', 'dead'], description: 'Eye state' },
    size: {
      control: { type: 'number', min: 9, max: 96, step: 1 },
      description: 'Eye diameter (px)',
    },
  },
  render: ({ inverted, tracking, blink, eyes, size }) => {
    const el = document.createElement('slicc-googly-eyes');
    if (inverted) el.setAttribute('inverted', '');
    if (tracking === false) el.setAttribute('tracking', 'off');
    if (blink) el.setAttribute('blink', '');
    if (eyes) el.setAttribute('eyes', eyes);
    if (size != null) el.setAttribute('size', String(size));
    return el;
  },
};

export default meta;
type Story = StoryObj<GooglyEyesArgs>;

/** Default: black pupils on white, tracking the cursor. Move the mouse to wiggle. */
export const Default: Story = { args: {} };

/** Open: the live, cursor-tracking eyes (no blink), shown larger to read clearly. */
export const Open: Story = { args: { eyes: 'open', size: 48 } };

/**
 * Blinking: a slow eyelid blink layered on top of cursor-tracking. Each eye runs
 * a slightly different cycle (~3.4s / ~4.6s) so the dip lands in the 3–5s band.
 * Enlarged so the squash is visible; no-ops under `prefers-reduced-motion`.
 */
export const Blinking: Story = { args: { blink: true, size: 48 } };

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
