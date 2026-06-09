import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-tag.js';

type Hue = 'rose' | 'cyan' | 'violet' | 'amber' | 'waffle' | 'green';

interface TagArgs {
  hue?: Hue | '';
  label?: string;
  dot?: boolean;
}

const meta: Meta<TagArgs> = {
  title: 'Primitives/Tag',
  component: 'slicc-tag',
  tags: ['autodocs'],
  argTypes: {
    hue: {
      control: 'select',
      options: ['', 'rose', 'cyan', 'violet', 'amber', 'waffle', 'green'],
      description: 'Tint hue (empty = neutral)',
    },
    label: { control: 'text', description: 'Chip text' },
    dot: { control: 'boolean', description: 'Show a leading tinted dot' },
  },
  render: ({ hue, label, dot }) => {
    const el = document.createElement('slicc-tag');
    if (hue) el.setAttribute('hue', hue);
    if (label) el.setAttribute('label', label);
    if (dot) el.setAttribute('dot', '');
    return el;
  },
};

export default meta;
type Story = StoryObj<TagArgs>;

export const Default: Story = { args: { label: 'tag' } };
export const Rose: Story = { args: { hue: 'rose', label: 'user' } };
export const Cyan: Story = { args: { hue: 'cyan', label: 'feedback' } };
export const Violet: Story = { args: { hue: 'violet', label: 'project' } };
export const Amber: Story = { args: { hue: 'amber', label: 'lick' } };
export const Waffle: Story = { args: { hue: 'waffle', label: 'cone' } };
export const Green: Story = { args: { hue: 'green', label: 'triage' } };
export const WithDot: Story = { args: { hue: 'violet', label: 'designer', dot: true } };

/** All hues at once — quick visual matrix for light/dark review. */
export const AllHues: StoryObj = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap = '8px';
    wrap.style.alignItems = 'center';
    const rows: Array<[Hue | '', string, boolean]> = [
      ['', 'neutral', false],
      ['rose', 'user', true],
      ['cyan', 'feedback', false],
      ['violet', 'project', true],
      ['amber', 'lick', false],
      ['waffle', 'cone', true],
      ['green', 'triage', false],
    ];
    for (const [hue, label, dot] of rows) {
      const el = document.createElement('slicc-tag');
      if (hue) el.setAttribute('hue', hue);
      el.setAttribute('label', label);
      if (dot) el.setAttribute('dot', '');
      wrap.appendChild(el);
    }
    return wrap;
  },
};
