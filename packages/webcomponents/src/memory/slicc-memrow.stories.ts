import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-memrow.js';

interface MemrowArgs {
  title?: string;
  summary?: string;
  tag?: 'user' | 'feedback' | 'project';
  fresh?: boolean;
}

/** Build a single memory row from story args. */
function buildRow(args: MemrowArgs): HTMLElement {
  const row = document.createElement('slicc-memrow');
  if (args.title) row.setAttribute('title', args.title);
  if (args.summary) row.setAttribute('summary', args.summary);
  if (args.tag) row.setAttribute('tag', args.tag);
  if (args.fresh) row.setAttribute('fresh', '');
  return row;
}

const meta: Meta<MemrowArgs> = {
  title: 'Memory/Memrow',
  component: 'slicc-memrow',
  tags: ['autodocs'],
  argTypes: {
    title: { control: 'text', description: 'Bold memory title' },
    summary: { control: 'text', description: 'Muted summary line' },
    tag: {
      control: 'select',
      options: ['user', 'feedback', 'project'],
      description: 'Memory tag kind (selects the right-pinned memtag)',
    },
    fresh: { control: 'boolean', description: 'Rose-tints the card as the newest memory' },
  },
  render: (args) => buildRow(args),
};

export default meta;
type Story = StoryObj<MemrowArgs>;

export const Default: Story = {
  args: {
    title: 'icon buttons need tooltips',
    summary: 'All icon-only buttons must have data-tooltip + aria-label.',
    tag: 'feedback',
  },
};

export const Fresh: Story = {
  args: {
    title: 'palette preference: warm paper',
    summary: 'Prefers paper #faf6f1 canvas + violet accent + single pill CTA for marketing pages.',
    tag: 'user',
    fresh: true,
  },
};

export const TagUser: Story = {
  args: {
    title: 'palette preference: warm paper',
    summary: 'Prefers paper #faf6f1 canvas + violet accent + single pill CTA.',
    tag: 'user',
  },
};

export const TagFeedback: Story = {
  args: {
    title: 'e2e via puppeteer-core',
    summary: 'Use puppeteer-core against the dev-server CDP for browser E2E.',
    tag: 'feedback',
  },
};

export const TagProject: Story = {
  args: {
    title: 'UI redesign exploration',
    summary: '3 axes — structure × palette × style; the "lick" blob; mockups in slicc-styles/.',
    tag: 'project',
  },
};

/**
 * A realistic, populated memory panel: the newest entry is `fresh`, followed by
 * feedback and project rows, inside a bordered overflow-auto container — exactly
 * how the prototype's `#membody` stacks `.memrow`s.
 */
export const Panel: Story = {
  render: () => {
    const panel = document.createElement('div');
    panel.style.cssText =
      'width:320px;max-height:300px;overflow:auto;padding:13px;border:1px solid var(--line);' +
      'border-radius:14px;background:var(--canvas);font-family:var(--ui);';

    const rows: MemrowArgs[] = [
      {
        title: 'palette preference: warm paper',
        summary:
          'Prefers paper #faf6f1 canvas + violet accent + single pill CTA for marketing pages.',
        tag: 'user',
        fresh: true,
      },
      {
        title: 'icon buttons need tooltips',
        summary: 'All icon-only buttons must have data-tooltip + aria-label.',
        tag: 'feedback',
      },
      {
        title: 'e2e via puppeteer-core',
        summary: 'Use puppeteer-core against the dev-server CDP for browser E2E.',
        tag: 'feedback',
      },
      {
        title: 'UI redesign exploration',
        summary: '3 axes — structure × palette × style; the "lick" blob; mockups in slicc-styles/.',
        tag: 'project',
      },
    ];

    for (const args of rows) panel.appendChild(buildRow(args));
    return panel;
  },
};
