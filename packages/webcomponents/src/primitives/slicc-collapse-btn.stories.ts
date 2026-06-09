import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-collapse-btn.js';

interface CollapseBtnArgs {
  label?: string;
  glyph?: string;
}

const meta: Meta<CollapseBtnArgs> = {
  title: 'Primitives/CollapseButton',
  component: 'slicc-collapse-btn',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Accessible label / title (default "Collapse")' },
    glyph: { control: 'text', description: 'Override the button glyph (default ⤡)' },
  },
  render: ({ label, glyph }) => {
    const el = document.createElement('slicc-collapse-btn');
    if (label) el.setAttribute('label', label);
    if (glyph) el.setAttribute('glyph', glyph);
    el.addEventListener('collapse', () => {
      // eslint-disable-next-line no-console
      console.log('collapse');
    });
    return el;
  },
};

export default meta;
type Story = StoryObj<CollapseBtnArgs>;

/** Idle state — the workbench-header collapse button as it appears at rest. */
export const Idle: Story = { args: {} };

/** Hover state — surfaced via the global Pseudo States toolbar in Storybook. */
export const Hover: Story = {
  args: {},
  parameters: { pseudo: { hover: true } },
};

/** Custom glyph override (default slot content also works). */
export const CustomGlyph: Story = { args: { glyph: '⤢', label: 'Expand' } };
