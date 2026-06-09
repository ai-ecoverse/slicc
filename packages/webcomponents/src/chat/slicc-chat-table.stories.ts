import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-chat-table.js';

interface TableArgs {
  headers?: string;
}

/** One `<tr>` row built via DOM so the `<tr>`/`<td>` survive (the HTML parser
 * drops table tags written as innerHTML outside a table context). */
function row(
  label: string,
  was: string,
  now: string,
  opts?: { code?: boolean }
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const head = document.createElement('td');
  head.textContent = label;

  const wasCell = document.createElement('td');
  wasCell.className = 'was';
  const nowCell = document.createElement('td');
  nowCell.className = 'now';

  if (opts?.code) {
    wasCell.innerHTML = `<code>${was}</code>`;
    nowCell.innerHTML = `<code>${now}</code>`;
  } else {
    wasCell.textContent = was;
    nowCell.textContent = now;
  }

  tr.append(head, wasCell, nowCell);
  return tr;
}

/** Build the prototype's hero-audit comparison table, verbatim. */
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

/** Default comparison table with attribute-driven headers and `.was` / `.now` tones. */
export const Comparison: Story = {
  args: { headers: 'Element, Current, Proposed' },
};

/** Cells wrapping inline `<code>` chips in both the muted-current and green tones. */
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

/** A slotted `<tr slot="head">` header row wins over the `headers` attribute. */
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
