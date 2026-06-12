import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-pane-tag.js';

interface PaneTagArgs {
  kind?: 'tool' | 'sprinkle' | '';
}

const meta: Meta<PaneTagArgs> = {
  title: 'Primitives/PaneTag',
  component: 'slicc-pane-tag',
  tags: ['autodocs'],
  argTypes: {
    kind: {
      control: 'inline-radio',
      options: ['tool', 'sprinkle', ''],
      description: 'Pane kind badge; empty/unrecognized hides the pill',
    },
  },
  render: ({ kind }) => {
    const el = document.createElement('slicc-pane-tag');
    if (kind) el.setAttribute('kind', kind);
    return el;
  },
};

export default meta;
type Story = StoryObj<PaneTagArgs>;

/** Violet `tool` pill — a pinned surface (Files / Terminal / Memory / browser). */
export const Tool: Story = { args: { kind: 'tool' } };

/** Violet `sprinkle` pill — a user-defined sprinkle surface. */
export const Sprinkle: Story = { args: { kind: 'sprinkle' } };

/** No recognized `kind` — the badge stays hidden (renders nothing visible). */
export const Hidden: Story = { args: { kind: '' } };
