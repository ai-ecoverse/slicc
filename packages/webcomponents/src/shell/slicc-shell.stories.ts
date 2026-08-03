import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-chat-thread.js';
import '../chat/slicc-user-message.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-input-card.js';
import '../dock/slicc-dock.js';
import '../workbench/slicc-dock-tree.js';
import '../workbench/slicc-surface.js';
import './slicc-chatpane.js';
import './slicc-shell.js';

function app(): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'display:flex;flex-direction:column;height:560px;width:980px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);';

  const shell = document.createElement('slicc-shell');
  const dockTree = document.createElement('slicc-dock-tree');

  // Chat is a pinned dock-tree leaf, exactly like the live shell.
  const chatSurface = document.createElement('slicc-surface');
  chatSurface.setAttribute('surface-id', 'chat');
  chatSurface.setAttribute('layout', 'flex');
  const pane = document.createElement('slicc-chatpane');
  const thread = document.createElement('slicc-chat-thread');
  const u = document.createElement('slicc-user-message');
  u.textContent = 'Open the files panel and show the file tree.';
  const a = document.createElement('slicc-agent-message');
  a.innerHTML = '<p>Sure — dragging the files panel into the tree.</p>';
  thread.append(u, a);
  const composer = document.createElement('slicc-composer');
  composer.innerHTML = '<slicc-input-card></slicc-input-card>';
  pane.append(thread, composer);
  chatSurface.append(pane);
  dockTree.append(chatSurface);
  (dockTree as unknown as { setPinned(ids: string[]): void }).setPinned(['chat']);
  (dockTree as unknown as { placeSurface(id: string, zone: string): void }).placeSurface(
    'chat',
    'left'
  );

  const dock = document.createElement('slicc-dock');
  shell.append(dockTree, dock);
  frame.appendChild(shell);
  return frame;
}

const meta: Meta = {
  title: 'Shell/Split Shell',
  component: 'slicc-shell',
  tags: ['autodocs'],
  render: () => app(),
};

export default meta;
type Story = StoryObj;

/** The dock-tree + dock rail, chat pinned as the sole starting leaf. */
export const Default: Story = {};
