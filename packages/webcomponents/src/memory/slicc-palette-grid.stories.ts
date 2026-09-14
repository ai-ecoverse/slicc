import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { PaletteToken, SliccPaletteGrid } from './slicc-palette-grid.js';
import './slicc-palette-grid.js';

import './slicc-palette-cell.js';

interface PaletteGridArgs {
  heading?: string;
  tokens?: PaletteToken[];
}

function buildGrid(args: PaletteGridArgs): SliccPaletteGrid {
  const grid = document.createElement('slicc-palette-grid') as SliccPaletteGrid;
  if (args.heading) grid.setAttribute('heading', args.heading);
  if (args.tokens) grid.tokens = args.tokens;
  return grid;
}

function inPanel(grid: HTMLElement, width = 340, height = 420): HTMLElement {
  const panel = document.createElement('div');
  panel.style.cssText =
    `display:flex;width:${width}px;height:${height}px;overflow:hidden;` +
    'border:1px solid var(--line);border-radius:14px;background:var(--canvas);';
  grid.style.flex = '1';
  panel.appendChild(grid);
  return panel;
}

const meta: Meta<PaletteGridArgs> = {
  title: 'Memory/PaletteGrid',
  component: 'slicc-palette-grid',
  tags: ['autodocs'],
  argTypes: {
    heading: { control: 'text', description: 'Panel heading' },
  },
  render: (args) => inPanel(buildGrid(args)),
};

export default meta;
type Story = StoryObj<PaletteGridArgs>;

export const Default: Story = {
  args: { heading: 'brand palette · tokens' },
};

export const WideReflow: Story = {
  render: (args) => inPanel(buildGrid(args), 560, 320),
  args: { heading: 'brand palette · tokens' },
};

export const NarrowScroll: Story = {
  render: (args) => inPanel(buildGrid(args), 160, 300),
  args: { heading: 'brand palette · tokens' },
};

export const ManyTokens: Story = {
  render: (args) => inPanel(buildGrid(args)),
  args: {
    heading: 'extended palette · 12 tokens',
    tokens: [
      { label: 'canvas #faf6f1', color: '#faf6f1' },
      { label: 'cone #ef7000', color: '#ef7000' },
      { label: 'scoop #8b5cf6', color: '#8b5cf6' },
      { label: 'scoop #06b6d4', color: '#06b6d4' },
      { label: 'scoop #f43f5e', color: '#f43f5e' },
      { label: 'amber #f59e0b', color: '#f59e0b' },
      { label: 'green #168a35', color: '#168a35' },
      { label: 'waffle #b07823', color: '#b07823' },
      { label: 'rose #f43f5e', color: '#f43f5e' },
      { label: 'cyan #06b6d4', color: '#06b6d4' },
      { label: 'violet #8b5cf6', color: '#8b5cf6' },
      { label: 'ink #0a0a0a', color: '#0a0a0a' },
    ],
  },
};

export const SingleToken: Story = {
  render: (args) => inPanel(buildGrid(args), 340, 180),
  args: {
    heading: 'accent · 1 token',
    tokens: [{ label: 'cone #ef7000', color: '#ef7000' }],
  },
};
