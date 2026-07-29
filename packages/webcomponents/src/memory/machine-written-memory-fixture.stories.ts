import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { createMemoryRows } from '../../../webapp/src/ui/wc/wc-memory.js';
import type { SliccMemoryPanel } from './slicc-memory-panel.js';
import './slicc-memory-panel.js';
import {
  MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_MARKDOWN,
} from './machine-written-memory-fixture.js';

function fixture(markdown: string): SliccMemoryPanel {
  const panel = document.createElement('slicc-memory-panel') as SliccMemoryPanel;
  panel.style.cssText = 'width:430px;height:760px;border:1px solid var(--line);border-radius:16px;';
  panel.setRows(createMemoryRows(markdown));
  return panel;
}

const meta: Meta = {
  title: 'Memory/Machine-written Fixture',
  component: 'slicc-memory-panel',
  parameters: { layout: 'centered', viewport: { defaultViewport: 'medium' } },
};

export default meta;
type Story = StoryObj;

export const RepeatedAppends: Story = {
  name: 'Repeated appends — dated/source blocks',
  render: () => fixture(MACHINE_WRITTEN_MEMORY_MARKDOWN),
};

export const PostRestructure: Story = {
  name: 'Post-restructure — one consolidated block',
  render: () => fixture(MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN),
};
