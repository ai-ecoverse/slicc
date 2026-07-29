import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { createMemoryRows } from '../../../webapp/src/ui/wc/wc-memory.js';
import {
  MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_MARKDOWN,
} from './machine-written-memory-fixture.js';
import type { SliccMemoryPanel } from './slicc-memory-panel.js';
import './slicc-memory-panel.js';
import { REDACTED_REAL_WORLD_MEMORY_MARKDOWN } from './redacted-real-world-memory-fixture.js';
import { SYNTHETIC_MEMORY_MARKDOWN } from './synthetic-memory-fixture.js';

function panel(width: number, markdown: string): SliccMemoryPanel {
  const panel = document.createElement('slicc-memory-panel') as SliccMemoryPanel;
  panel.style.cssText = `width:${width}px;height:760px;border:1px solid var(--line);border-radius:16px;`;
  panel.setRows(createMemoryRows(markdown));
  return panel;
}

const meta: Meta = {
  title: 'Memory/Panel',
  component: 'slicc-memory-panel',
  parameters: {
    layout: 'centered',
    viewport: { defaultViewport: 'medium' },
  },
};

export default meta;
type Story = StoryObj;

export const TopicalFixture: Story = {
  name: 'Topical fixture',
  render: () => panel(520, SYNTHETIC_MEMORY_MARKDOWN),
};

export const MachineWritten: Story = {
  name: 'Machine-written blocks',
  render: () => panel(520, MACHINE_WRITTEN_MEMORY_MARKDOWN),
};

export const Consolidated: Story = {
  name: 'Consolidated fallback',
  render: () => panel(520, MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN),
};

export const RedactedRealWorld: Story = {
  name: 'Redacted real-world fixture',
  render: () => panel(520, REDACTED_REAL_WORLD_MEMORY_MARKDOWN),
};
