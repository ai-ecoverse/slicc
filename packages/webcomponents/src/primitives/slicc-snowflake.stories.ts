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

export const Frozen: Story = { args: {} };

export const Thawing: Story = { args: { thawed: true } };

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
