import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-snowflake.js';

interface SnowflakeArgs {
  thawed?: boolean;
}

const meta: Meta<SnowflakeArgs> = {
  title: 'Primitives/Snowflake',
  component: 'slicc-snowflake',
  tags: ['autodocs'],
  argTypes: {
    thawed: { control: 'boolean', description: 'Rose "thawing" flash state' },
  },
  render: ({ thawed }) => {
    const el = document.createElement('slicc-snowflake');
    if (thawed) el.setAttribute('thawed', '');
    return el;
  },
};

export default meta;
type Story = StoryObj<SnowflakeArgs>;

/**
 * Frozen / idle — the default freezer badge: ghost fill, `--line` border, and
 * the lucide `snowflake` glyph tinted with `--txt-2`.
 */
export const Frozen: Story = { args: {} };

/** Thawing — the rose flash shown for ~1400ms when a frozen session is reopened. */
export const Thawing: Story = { args: { thawed: true } };

/**
 * A row of frozen badges next to the thawing flash, mirroring the prototype's
 * freezer rail where one card has just been clicked.
 */
export const FreezerRail: Story = {
  render: () => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;';
    for (let i = 0; i < 4; i++) row.appendChild(document.createElement('slicc-snowflake'));
    const thawed = document.createElement('slicc-snowflake');
    thawed.setAttribute('thawed', '');
    row.appendChild(thawed);
    return row;
  },
};
