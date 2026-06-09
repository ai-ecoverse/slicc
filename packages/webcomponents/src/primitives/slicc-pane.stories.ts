import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-pane.js';

interface PaneArgs {
  elevated?: boolean;
}

/** Build a representative pane with a header chrome row and a scrollable body. */
function buildPane({ elevated }: PaneArgs): HTMLElement {
  const pane = document.createElement('slicc-pane');
  if (elevated) pane.setAttribute('elevated', '');
  pane.style.width = '360px';
  pane.style.height = '220px';

  const header = document.createElement('div');
  header.setAttribute('slot', 'header');
  header.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-family:var(--ui);font-size:12px;color:var(--txt-2);';
  header.textContent = 'workbench · preview';

  const body = document.createElement('div');
  body.style.cssText = 'padding:14px;font-family:var(--ui);font-size:13px;color:var(--ink);';
  body.innerHTML = Array.from(
    { length: 12 },
    (_, i) =>
      `<p style="margin:0 0 10px;">Pane body line ${i + 1} — scrolls within the clipped surface.</p>`
  ).join('');

  pane.append(header, body);
  return pane;
}

const meta: Meta<PaneArgs> = {
  title: 'Primitives/Pane',
  component: 'slicc-pane',
  tags: ['autodocs'],
  argTypes: {
    elevated: {
      control: 'boolean',
      description: 'Heavier two-layer shadow (the prototype .workbench lift)',
    },
  },
  render: (args) => buildPane(args),
};

export default meta;
type Story = StoryObj<PaneArgs>;

export const Default: Story = { args: { elevated: false } };
export const Elevated: Story = { args: { elevated: true } };
