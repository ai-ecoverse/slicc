import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { PaletteToken, SliccPaletteGrid } from './slicc-palette-grid.js';
import './slicc-palette-grid.js';
// Sibling composed by tag — importing it registers <slicc-palette-cell> so the
// grid's chips upgrade in the story canvas.
import './slicc-palette-cell.js';

interface PaletteGridArgs {
  heading?: string;
  tokens?: PaletteToken[];
}

/** Build a palette grid from story args. */
function buildGrid(args: PaletteGridArgs): SliccPaletteGrid {
  const grid = document.createElement('slicc-palette-grid') as SliccPaletteGrid;
  if (args.heading) grid.setAttribute('heading', args.heading);
  if (args.tokens) grid.tokens = args.tokens;
  return grid;
}

/**
 * Wrap the grid in a fixed-size panel so the auto-fill reflow and the vertical
 * scroll are reviewable — mirrors the prototype's right-rail `.pal` surface.
 */
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

/** The default brand palette (canvas / cone / scoop×3 / ink) from the prototype. */
export const Default: Story = {
  args: { heading: 'brand palette · tokens' },
};

/**
 * A wider panel so the `repeat(auto-fill, minmax(96px, 1fr))` grid fits more
 * columns per row — demonstrates the width-driven reflow.
 */
export const WideReflow: Story = {
  render: (args) => inPanel(buildGrid(args), 560, 320),
  args: { heading: 'brand palette · tokens' },
};

/**
 * A narrow panel so the grid collapses toward a single column and the panel
 * scrolls vertically — the responsive lower bound.
 */
export const NarrowScroll: Story = {
  render: (args) => inPanel(buildGrid(args), 160, 300),
  args: { heading: 'brand palette · tokens' },
};

/**
 * A custom, larger token set so the swatch grid scrolls and shows light vs dark
 * chip rendering across many hues.
 */
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

/**
 * A single token — the minimal grid; the lone chip still fills the auto-fill
 * first column.
 */
export const SingleToken: Story = {
  render: (args) => inPanel(buildGrid(args), 340, 180),
  args: {
    heading: 'accent · 1 token',
    tokens: [{ label: 'cone #ef7000', color: '#ef7000' }],
  },
};
