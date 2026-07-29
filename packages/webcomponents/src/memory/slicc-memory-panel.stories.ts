import type { Meta, StoryObj } from '@storybook/web-components-vite';
import {
  MACHINE_WRITTEN_MEMORY_CONSOLIDATED_MARKDOWN,
  MACHINE_WRITTEN_MEMORY_MARKDOWN,
} from './machine-written-memory-fixture.js';
import type { SliccMemoryPanel } from './slicc-memory-panel.js';
import './slicc-memory-panel.js';
import { REDACTED_REAL_WORLD_MEMORY_MARKDOWN } from './redacted-real-world-memory-fixture.js';
import { SYNTHETIC_MEMORY_MARKDOWN } from './synthetic-memory-fixture.js';

interface FixtureRow {
  markdown: string;
  section: string;
}

function fixtureBullets(markdown: string): FixtureRow[] {
  const rows: FixtureRow[] = [];
  let section = 'General';
  let subsection = '';
  let pending: FixtureRow | null = null;
  const flush = (): void => {
    if (pending) rows.push(pending);
    pending = null;
  };
  for (const line of markdown.split('\n')) {
    const heading = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      if (heading[1].length === 2) {
        section = heading[2];
        subsection = '';
      } else {
        subsection = heading[2];
      }
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      flush();
      pending = {
        markdown: bullet[1],
        section: [section, subsection].filter(Boolean).join(' / '),
      };
    } else if (pending && /^\s{2,}\S/.test(line)) {
      pending.markdown += ` ${line.trim()}`;
    }
  }
  flush();
  return rows;
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\\([`*_])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitText(markdown: string): { heading: string; summary: string } {
  const text = plainText(markdown);
  const boundary = /^(.{8,90}?)(?:([.!?])|[:;]|\s[—–])\s+(.+)$/.exec(text);
  return boundary
    ? { heading: boundary[1] + (boundary[2] ?? ''), summary: boundary[3] }
    : { heading: text, summary: '' };
}

function tagFor(section: string, markdown: string): 'user' | 'feedback' | 'project' | null {
  const autoExtracted = /^Auto-extracted \(/.test(section);
  const evidence = autoExtracted ? markdown : `${section} ${markdown}`;
  if (/\b(feedback|reviews?|testing|verification)\b/i.test(evidence)) return 'feedback';
  if (/\b(preference|identity|interface|working rhythm|keyboard|accessibility)\b/i.test(evidence))
    return 'user';
  return autoExtracted ? null : 'project';
}

function createFixtureRows(markdownFixture: string): HTMLElement[] {
  return fixtureBullets(markdownFixture).map(({ markdown, section }) => {
    const { heading, summary } = splitText(markdown);
    const row = document.createElement('slicc-memrow');
    row.setAttribute('heading', heading);
    if (summary) row.setAttribute('summary', summary);
    row.setAttribute('section', section);
    const tag = tagFor(section, markdown);
    if (tag) row.setAttribute('tag', tag);
    return row;
  });
}

function panel(width: number, markdown: string): SliccMemoryPanel {
  const panel = document.createElement('slicc-memory-panel') as SliccMemoryPanel;
  panel.style.cssText = `width:${width}px;height:760px;border:1px solid var(--line);border-radius:16px;`;
  panel.setRows(createFixtureRows(markdown));
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
