import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-pill.js';

interface PillArgs {
  type?: 'cone' | 'scoop';
  color?: string;
  eyes?: 'open' | 'none' | 'dead';
  active?: boolean;
  label?: string;
  pupil?: number;
  fill?: number;
  theme?: 'light' | 'dark';
}

const meta: Meta<PillArgs> = {
  title: 'Pill/Pill',
  component: 'slicc-pill',
  tags: ['autodocs'],
  argTypes: {
    type: { control: 'inline-radio', options: ['cone', 'scoop'], description: 'Glyph type' },
    color: { control: 'color', description: 'Accent color; glyph + border derive from it' },
    eyes: { control: 'inline-radio', options: ['open', 'none', 'dead'], description: 'Eye state' },
    active: { control: 'boolean', description: 'Fill the pill with the accent' },
    label: { control: 'text', description: 'Chip label' },
    pupil: {
      control: { type: 'number', min: 0.3, max: 2.4, step: 0.1 },
      description: 'Explicit pupil scale (wins over fill)',
    },
    fill: {
      control: { type: 'number', min: 0, max: 100, step: 1 },
      description: 'Fullness 0–100; ramps pupil dilation',
    },
    theme: {
      control: 'inline-radio',
      options: ['light', 'dark'],
      description: 'Chip-token theme override',
    },
  },
  render: ({ type, color, eyes, active, label, pupil, fill, theme }) => {
    const el = document.createElement('slicc-pill');
    if (type) el.setAttribute('type', type);
    if (color) el.setAttribute('color', color);
    if (eyes) el.setAttribute('eyes', eyes);
    if (active) el.setAttribute('active', '');
    if (label != null) el.setAttribute('label', label);
    if (pupil != null) el.setAttribute('pupil', String(pupil));
    if (fill != null) el.setAttribute('fill', String(fill));
    if (theme) el.setAttribute('theme', theme);
    return el;
  },
};

export default meta;
type Story = StoryObj<PillArgs>;

/** Cone, eyes open, idle — the default cone chip. Move the mouse to track. */
export const ConeOpenIdle: Story = { args: { type: 'cone', label: 'sliccy' } };

/** Cone, eyes open, active — accent fills the pill, white label. */
export const ConeOpenActive: Story = { args: { type: 'cone', label: 'sliccy', active: true } };

/** Cone with no eyes (idle glyph only). */
export const ConeNoEyes: Story = { args: { type: 'cone', label: 'sliccy', eyes: 'none' } };

/** Cone with dead "X X" eyes — the finished/failed look. */
export const ConeDead: Story = { args: { type: 'cone', label: 'sliccy', eyes: 'dead' } };

/** Scoop, eyes open, idle — the default scoop chip. */
export const ScoopOpenIdle: Story = { args: { type: 'scoop', label: 'researcher' } };

/** Scoop, eyes open, active — accent fills the pill. */
export const ScoopOpenActive: Story = {
  args: { type: 'scoop', label: 'researcher', active: true },
};

/** Scoop with no eyes. */
export const ScoopNoEyes: Story = { args: { type: 'scoop', label: 'researcher', eyes: 'none' } };

/** Scoop with dead eyes. */
export const ScoopDead: Story = { args: { type: 'scoop', label: 'researcher', eyes: 'dead' } };

/** Custom accent color cone. */
export const CustomColor: Story = {
  args: { type: 'cone', color: '#8b5cf6', label: 'violet cone' },
};

/** Dilated pupils via a high `fill` level (full scoop = big pupils). */
export const FilledPupils: Story = { args: { type: 'scoop', label: 'full', fill: 90 } };

/** Explicit large pupil scale via the `pupil` attribute. */
export const BigPupil: Story = { args: { type: 'scoop', label: 'wide eyes', pupil: 2.2 } };

/** Forced dark chip tokens regardless of the page color scheme. */
export const DarkTheme: Story = { args: { type: 'cone', label: 'dark', theme: 'dark' } };
