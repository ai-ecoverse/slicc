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

export const Default: Story = { args: {} };

export const Open: Story = { args: { eyes: 'open', size: 48 } };

export const Blinking: Story = { args: { blink: true, size: 48 } };

export const Inverted: Story = { args: { inverted: true } };

export const Tracking: Story = { args: { tracking: true } };

export const Idle: Story = { args: { tracking: false } };

export const Dead: Story = { args: { eyes: 'dead' } };

export const Large: Story = { args: { size: 64 } };
