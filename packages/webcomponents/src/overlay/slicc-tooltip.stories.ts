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

/** A small square icon trigger to hang the tip on. */
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

/** Hover (or focus) the icon to reveal the label. */
export const Hover: Story = { render: () => tip('Files · VFS', 'top') };

/** Forced open via the `open` attribute — the four placements around a trigger. */
export const Placements: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:64px;padding:48px;';
    for (const p of ['top', 'bottom', 'left', 'right']) wrap.append(tip(p, p, true));
    return wrap;
  },
};

/** Wrapping a rail icon (left rail → tip on the right), the collapsed-view use. */
export const RailIcon: Story = { render: () => tip('Terminal', 'right', true) };
