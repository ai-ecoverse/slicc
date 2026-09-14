import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h } from '../internal/dom.js';
import './slicc-chat-table.js';

interface TableArgs {
  headers?: string;
}

function row(
  label: string,
  was: string,
  now: string,
  opts?: { code?: boolean }
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const head = document.createElement('td');
  head.textContent = label;

  const wasCell = h('td', { class: 'was' }, opts?.code ? h('code', null, was) : was);
  const nowCell = h('td', { class: 'now' }, opts?.code ? h('code', null, now) : now);

  tr.append(head, wasCell, nowCell);
  return tr;
}

function buildComparison({ headers }: TableArgs): HTMLElement {
  const table = document.createElement('slicc-chat-table');
  if (headers) table.setAttribute('headers', headers);
  table.append(
    row('Canvas', '#0e0e0f', '#faf6f1', { code: true }),
    row('Headline', 'mono · 28px', 'Fraunces · 64px'),
    row('Primary actions', '6 buttons', '1 pill CTA'),
    row('Body contrast', '3.1 : 1', '5.2 : 1')
  );
  return table;
}

const meta: Meta<TableArgs> = {
  title: 'Chat/ChatTable',
  component: 'slicc-chat-table',
  tags: ['autodocs'],
  argTypes: {
    headers: {
      control: 'text',
      description: 'Comma-separated header labels (used when no slotted <tr slot="head"> is given)',
    },
  },
  render: (args) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;padding:18px;font-family:var(--ui);';
    wrap.appendChild(buildComparison(args));
    return wrap;
  },
};

export default meta;
type Story = StoryObj<TableArgs>;

export const Comparison: Story = {
  args: { headers: 'Element, Current, Proposed' },
};

export const WithCodeChips: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;padding:18px;font-family:var(--ui);';
    const table = document.createElement('slicc-chat-table');
    table.setAttribute('headers', 'Token, Current, Proposed');
    table.append(
      row('--canvas', '#0e0e0f', '#faf6f1', { code: true }),
      row('--ink', '#e8e8ea', '#1b1b1f', { code: true }),
      row('--accent', '#3b82f6', '#e0792b', { code: true })
    );
    wrap.appendChild(table);
    return wrap;
  },
};

export const SlottedHeaderRow: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;padding:18px;font-family:var(--ui);';
    const table = document.createElement('slicc-chat-table');

    const head = document.createElement('tr');
    head.setAttribute('slot', 'head');
    for (const label of ['Setting', 'Before', 'After']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }

    table.append(
      head,
      row('Theme', 'light only', 'light + dark'),
      row('Density', 'comfortable', 'compact')
    );
    wrap.appendChild(table);
    return wrap;
  },
};

export const LongUnbreakableStrings: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:420px;padding:18px;font-family:var(--ui);';
    const url =
      'https://example.com/very/long/path/segment/here?query=some-really-long-value&token=0123456789abcdef0123456789abcdef';
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const path =
      '/Users/dev/workspace/packages/webcomponents/src/chat/components/really/deeply/nested/directory/slicc-chat-table.ts';
    const table = document.createElement('slicc-chat-table');
    table.setAttribute('headers', 'Field, Value, Kind');
    table.append(
      row('Clone URL', url, 'url', { code: true }),
      row('Commit SHA', hash, 'hash', { code: true }),
      row('File path', path, 'path', { code: true })
    );
    wrap.appendChild(table);
    return wrap;
  },
};
