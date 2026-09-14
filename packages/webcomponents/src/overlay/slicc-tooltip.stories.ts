import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../primitives/slicc-icon-button.js';
import './slicc-tooltip.js';

const meta: Meta = {
  title: 'Overlay/Tooltip',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

function icon(name: string): HTMLElement {
  const b = document.createElement('slicc-icon-button');
  b.setAttribute('icon', name);
  return b;
}

function tip(label: string, placement: string, open = false): HTMLElement {
  const t = document.createElement('slicc-tooltip');
  t.setAttribute('label', label);
  t.setAttribute('placement', placement);
  if (open) t.setAttribute('open', '');
  t.append(icon('folder'));
  return t;
}

export const Hover: Story = { render: () => tip('Files · VFS', 'top') };

export const Placements: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:64px;padding:48px;';
    for (const p of ['top', 'bottom', 'left', 'right']) wrap.append(tip(p, p, true));
    return wrap;
  },
};

export const RailIcon: Story = { render: () => tip('Terminal', 'right', true) };
