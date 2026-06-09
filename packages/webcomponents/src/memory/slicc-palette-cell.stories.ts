import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-palette-cell.js';

interface CellArgs {
  color?: string;
  label?: string;
  group?: string;
  selected?: boolean;
}

const meta: Meta<CellArgs> = {
  title: 'Memory/PaletteCell',
  component: 'slicc-palette-cell',
  tags: ['autodocs'],
  argTypes: {
    color: { control: 'color', description: 'Chip color (painted as the .ch background)' },
    label: { control: 'text', description: 'Cell caption' },
    group: { control: 'text', description: 'Selection group (same-group cells are exclusive)' },
    selected: { control: 'boolean', description: 'Draw the violet double-ring' },
  },
  render: ({ color, label, group, selected }) => {
    const el = document.createElement('slicc-palette-cell');
    if (color) el.setAttribute('color', color);
    if (label != null) el.setAttribute('label', label);
    if (group) el.setAttribute('group', group);
    if (selected) el.setAttribute('selected', '');
    el.style.width = '88px';
    return el;
  },
};

export default meta;
type Story = StoryObj<CellArgs>;

/** Idle cell — bordered card, 38px chip, label. Hover lifts it `-1px`. */
export const Idle: Story = { args: { color: '#faf6f1', label: 'paper' } };

/** Selected cell — the violet double-ring (`0 0 0 2px #fff, 0 0 0 4px var(--violet)`). */
export const Selected: Story = { args: { color: '#ef7000', label: 'cone', selected: true } };

/** A saturated accent chip (the prototype "violet" accent swatch). */
export const AccentChip: Story = {
  args: { color: '#8b5cf6', label: 'violet', group: 'accent', selected: true },
};

/** A pale canvas chip (the prototype "cream" canvas swatch). */
export const CanvasChip: Story = { args: { color: '#fff7ed', label: 'cream', group: 'canvas' } };

/** Built a populated palette grid that mirrors the prototype Hero-studio dip:
 *  a `canvas` group and an `accent` group, each single-select. Clicking a cell
 *  selects it and clears its same-group siblings via `palette-select`. */
export const PaletteGrid: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;flex-direction:column;gap:12px;padding:13px;width:360px;' +
      'font-family:var(--ui);';

    const buildGroup = (
      name: string,
      cells: ReadonlyArray<{ color: string; label: string; selected?: boolean }>
    ): HTMLElement => {
      const grid = document.createElement('div');
      grid.dataset.grp = name;
      grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;';
      for (const c of cells) {
        const cell = document.createElement('slicc-palette-cell');
        cell.setAttribute('color', c.color);
        cell.setAttribute('label', c.label);
        cell.setAttribute('group', name);
        if (c.selected) cell.setAttribute('selected', '');
        grid.appendChild(cell);
      }
      return grid;
    };

    wrap.appendChild(
      buildGroup('canvas', [
        { color: '#faf6f1', label: 'paper', selected: true },
        { color: '#fff7ed', label: 'cream' },
        { color: '#f5f3ff', label: 'lilac' },
        { color: '#fef2f2', label: 'blush' },
      ])
    );
    wrap.appendChild(
      buildGroup('accent', [
        { color: '#8b5cf6', label: 'violet' },
        { color: '#f43f5e', label: 'rose' },
        { color: '#06b6d4', label: 'cyan' },
        { color: '#ef7000', label: 'cone', selected: true },
      ])
    );
    return wrap;
  },
};

/** Slotted label fallback — no `label` attribute, content projected via the default slot. */
export const SlottedLabel: Story = {
  render: () => {
    const el = document.createElement('slicc-palette-cell');
    el.setAttribute('color', '#06b6d4');
    el.style.width = '88px';
    el.textContent = 'cyan';
    return el;
  },
};
