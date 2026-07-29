import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccMemoryPanel } from './slicc-memory-panel.js';
import './slicc-memory-panel.js';
import {
  MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_MARKDOWN,
} from './machine-written-memory-fixture.js';

function tagFor(markdown: string): 'user' | 'feedback' | null {
  if (/\b(feedback|reviews?|testing|verification)\b/i.test(markdown)) return 'feedback';
  if (/\b(preference|identity|interface|keyboard|accessibility)\b/i.test(markdown)) return 'user';
  return null;
}

function rowsFrom(markdown: string): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let section = 'Memory';
  let pending: string[] | null = null;
  const flush = (): void => {
    if (!pending) return;
    const row = document.createElement('slicc-memrow');
    const markdown = pending.join(' ');
    row.setAttribute('heading', markdown.replace(/[*`]/g, ''));
    row.setAttribute('section', section);
    const tag = tagFor(markdown);
    if (tag) row.setAttribute('tag', tag);
    rows.push(row);
    pending = null;
  };
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      section = heading[1];
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      pending = [bullet[1]];
    } else if (pending && /^\s{2,}\S/.test(line)) {
      pending.push(line.trim());
    }
  }
  flush();
  return rows;
}

function fixture(markdown: string): SliccMemoryPanel {
  const panel = document.createElement('slicc-memory-panel') as SliccMemoryPanel;
  panel.style.cssText = 'width:430px;height:760px;border:1px solid var(--line);border-radius:16px;';
  panel.setRows(rowsFrom(markdown));
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
