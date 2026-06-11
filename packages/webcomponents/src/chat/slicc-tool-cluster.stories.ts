import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-action-row.js';
import './slicc-tool-cluster.js';

const meta: Meta = {
  title: 'Chat/ToolCluster',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

function row(icon: string, label: string, result: string, body?: string): HTMLElement {
  const el = document.createElement('slicc-action-row');
  el.setAttribute('icon', icon);
  el.setAttribute('label', label);
  el.setAttribute('result', result);
  if (body) {
    const b = document.createElement('div');
    b.setAttribute('slot', 'body');
    b.textContent = body;
    el.append(b);
  }
  return el;
}

function cluster(opts: { label?: string; open?: boolean }): HTMLElement {
  const el = document.createElement('slicc-tool-cluster');
  if (opts.label) el.setAttribute('label', opts.label);
  if (opts.open) el.setAttribute('open', '');
  el.append(
    row('git-branch', "Use Sliccy's computer", 'done', '$ git status\nOn branch main'),
    row('git-branch', "Use Sliccy's computer", 'done', '$ git add -A'),
    row('git-branch', "Use Sliccy's computer", 'done', '$ git push origin main'),
    row('file-pen', 'Edit release-notes.md', 'done'),
    row('terminal', "Use Sliccy's computer", 'error', '$ npm publish\nE403')
  );
  return el;
}

/** Collapsed (default): one summary row standing in for five tool calls. */
export const Collapsed: Story = {
  render: () => cluster({ label: 'Figure out how to push to a branch' }),
};

/** Expanded: the wrapped rows behind the context-accent rail. */
export const Expanded: Story = {
  render: () => cluster({ label: 'Figure out how to push to a branch', open: true }),
};

/** No label yet (the quickLabel call is still in flight) — generic fallback. */
export const PendingLabel: Story = {
  render: () => cluster({}),
};
