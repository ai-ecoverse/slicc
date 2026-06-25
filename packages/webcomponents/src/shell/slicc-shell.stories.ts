import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-chat-thread.js';
import '../chat/slicc-user-message.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-input-card.js';
import '../dock/slicc-dock.js';
import '../workbench/slicc-workbench-pane.js';
import './slicc-chatpane.js';
import './slicc-shell.js';

interface ShellArgs {
  open: boolean;
  chatWidth?: string;
}

function app(open: boolean, chatWidth?: string): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'display:flex;flex-direction:column;height:560px;width:980px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);';

  const shell = document.createElement('slicc-shell');
  if (open) shell.setAttribute('open', '');
  if (chatWidth) shell.style.setProperty('--slicc-chat-w', chatWidth);

  // Chat pane
  const pane = document.createElement('slicc-chatpane');
  const thread = document.createElement('slicc-chat-thread');
  const u = document.createElement('slicc-user-message');
  u.textContent = 'Open the workbench and show the file tree.';
  const a = document.createElement('slicc-agent-message');
  a.innerHTML = '<p>Sure — toggling the workbench pane open.</p>';
  thread.append(u, a);
  const composer = document.createElement('slicc-composer');
  composer.innerHTML = '<slicc-input-card></slicc-input-card>';
  pane.append(thread, composer);

  // Workbench + dock
  const workbench = document.createElement('slicc-workbench-pane');
  const dock = document.createElement('slicc-dock');

  shell.append(pane, workbench, dock);
  frame.appendChild(shell);
  return frame;
}

const meta: Meta<ShellArgs> = {
  title: 'Shell/Split Shell',
  component: 'slicc-shell',
  tags: ['autodocs'],
  render: ({ open, chatWidth }) => app(open, chatWidth),
};

export default meta;
type Story = StoryObj<ShellArgs>;

export const Collapsed: Story = { args: { open: false } };
export const Open: Story = { args: { open: true } };

/** Chat widened to 60% — demonstrates the resize split via `--slicc-chat-w`. */
export const CustomSplit: Story = { args: { open: true, chatWidth: '60%' } };
