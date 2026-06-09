import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-swatch.js';

interface SwatchArgs {
  color?: string;
  hue?: boolean;
  selected?: boolean;
  label?: string;
}

const meta: Meta<SwatchArgs> = {
  title: 'Primitives/Swatch',
  component: 'slicc-swatch',
  tags: ['autodocs'],
  argTypes: {
    color: { control: 'color', description: 'CSS color used as the swatch fill' },
    hue: { control: 'boolean', description: 'Borderless accent/hue swatch (fills edge to edge)' },
    selected: { control: 'boolean', description: 'Renders the violet double-ring' },
    label: { control: 'text', description: 'Accessible label (defaults to the color)' },
  },
  render: ({ color, hue, selected, label }) => {
    const el = document.createElement('slicc-swatch');
    if (color) el.setAttribute('color', color);
    if (hue) el.toggleAttribute('hue', true);
    if (selected) el.toggleAttribute('selected', true);
    if (label) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<SwatchArgs>;

/** Canvas swatch — bordered, idle. */
export const Canvas: Story = { args: { color: '#faf6f1' } };

/** Canvas swatch — selected, with the violet double-ring. */
export const CanvasSelected: Story = { args: { color: '#faf6f1', selected: true } };

/** Hue/accent swatch — borderless, idle. */
export const Hue: Story = { args: { color: '#8b5cf6', hue: true } };

/** Hue/accent swatch — borderless, selected. */
export const HueSelected: Story = { args: { color: '#8b5cf6', hue: true, selected: true } };

/** The full canvas row from the prototype hero-studio controls. */
export const CanvasRow: Story = {
  render: () => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.style.flexWrap = 'wrap';
    for (const [i, color] of ['#faf6f1', '#fff7ed', '#fef2f2', '#f5f3ff'].entries()) {
      const sw = document.createElement('slicc-swatch');
      sw.setAttribute('color', color);
      if (i === 0) sw.toggleAttribute('selected', true);
      row.appendChild(sw);
    }
    return row;
  },
};

/** The full accent row from the prototype hero-studio controls (borderless hues). */
export const AccentRow: Story = {
  render: () => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.style.flexWrap = 'wrap';
    for (const [i, color] of ['#8b5cf6', '#f43f5e', '#06b6d4', '#ef7000'].entries()) {
      const sw = document.createElement('slicc-swatch');
      sw.setAttribute('color', color);
      sw.toggleAttribute('hue', true);
      if (i === 0) sw.toggleAttribute('selected', true);
      row.appendChild(sw);
    }
    return row;
  },
};
