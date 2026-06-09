import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-snowflake.js';

interface SnowflakeArgs {
  thawed?: boolean;
  svg?: boolean;
}

const meta: Meta<SnowflakeArgs> = {
  title: 'Primitives/Snowflake',
  component: 'slicc-snowflake',
  tags: ['autodocs'],
  argTypes: {
    thawed: { control: 'boolean', description: 'Rose "thawing" flash state' },
    svg: { control: 'boolean', description: 'Render the crisp inline six-point SVG instead of ❄' },
  },
  render: ({ thawed, svg }) => {
    const el = document.createElement('slicc-snowflake');
    if (thawed) el.setAttribute('thawed', '');
    if (svg) el.setAttribute('svg', '');
    return el;
  },
};

export default meta;
type Story = StoryObj<SnowflakeArgs>;

/** Frozen / idle — the default freezer badge: ghost fill, `--line` border, `--txt-2` glyph. */
export const Frozen: Story = { args: {} };

/** Thawing — the rose flash shown for ~1400ms when a frozen session is reopened. */
export const Thawing: Story = { args: { thawed: true } };

/** Crisp inline six-point SVG glyph (frozen). */
export const Svg: Story = { args: { svg: true } };

/** Crisp inline six-point SVG glyph in the rose thawing flash. */
export const SvgThawing: Story = { args: { svg: true, thawed: true } };
