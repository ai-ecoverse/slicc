import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-collapse-btn.js';

interface CollapseBtnArgs {
  label?: string;
  icon?: string;
}

const meta: Meta<CollapseBtnArgs> = {
  title: 'Primitives/CollapseButton',
  component: 'slicc-collapse-btn',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Accessible label / title (default "Collapse")' },
    icon: {
      control: 'text',
      description: 'Lucide icon name, kebab-case (default "panel-right-close")',
    },
  },
  render: ({ label, icon }) => {
    const el = document.createElement('slicc-collapse-btn');
    if (label) el.setAttribute('label', label);
    if (icon) el.setAttribute('icon', icon);
    el.addEventListener('collapse', () => {
      // eslint-disable-next-line no-console
      console.log('collapse');
    });
    return el;
  },
};

export default meta;
type Story = StoryObj<CollapseBtnArgs>;

/**
 * Idle state — the workbench-header collapse button at rest, rendering the
 * default lucide `panel-right-close` glyph in `--txt-2` on `--canvas`.
 */
export const Idle: Story = { args: {} };

/** Hover state — surfaced via the global Pseudo States toolbar in Storybook. */
export const Hover: Story = {
  args: {},
  parameters: { pseudo: { hover: true } },
};

/**
 * Alternate `chevrons-right-left` icon — the "compress horizontally" reading of
 * collapse, for contexts where the panel-fold metaphor is less apt.
 */
export const ChevronsIcon: Story = { args: { icon: 'chevrons-right-left' } };

/** Custom label — the accessible name / tooltip is independent of the glyph. */
export const CustomLabel: Story = { args: { label: 'Collapse workbench' } };

/**
 * Slotted custom content overrides the lucide icon entirely (here a bespoke
 * inline `<svg>`); the button chrome, hover, and `collapse` event are unchanged.
 */
export const SlottedContent: Story = {
  args: { label: 'Close' },
  render: ({ label }) => {
    const el = document.createElement('slicc-collapse-btn');
    if (label) el.setAttribute('label', label);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({
      width: '16',
      height: '16',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    })) {
      svg.setAttribute(k, v);
    }
    for (const d of ['M18 6 6 18', 'm6 6 12 12']) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    el.appendChild(svg);
    el.addEventListener('collapse', () => {
      // eslint-disable-next-line no-console
      console.log('collapse');
    });
    return el;
  },
};
