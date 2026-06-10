import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-chat-thread.js';
import '../chat/slicc-user-message.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-input-card.js';
import '../nav/slicc-nav.js';
import './slicc-chatpane.js';

interface ChatpaneArgs {
  narrow: boolean;
}

function populated(narrow: boolean): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'display:flex;height:520px;width:880px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);';
  const pane = document.createElement('slicc-chatpane');
  if (narrow) pane.setAttribute('narrow', '');

  const thread = document.createElement('slicc-chat-thread');
  const u = document.createElement('slicc-user-message');
  u.textContent = 'Make the freezer background frost slowly.';
  const a = document.createElement('slicc-agent-message');
  a.innerHTML = '<p>On it — wiring the frost shader into the freezer rail now.</p>';
  thread.append(u, a);

  const composer = document.createElement('slicc-composer');
  composer.innerHTML = '<slicc-input-card></slicc-input-card>';

  pane.append(thread, composer);
  frame.appendChild(pane);
  // A faux dock gutter so the 34% narrow split reads against something.
  const gutter = document.createElement('div');
  gutter.style.cssText = 'flex:1;background:color-mix(in srgb,var(--ctx) 8%,var(--bg));';
  frame.appendChild(gutter);
  return frame;
}

const meta: Meta<ChatpaneArgs> = {
  title: 'Shell/Chat Pane',
  component: 'slicc-chatpane',
  tags: ['autodocs'],
  render: ({ narrow }) => populated(narrow),
};

export default meta;
type Story = StoryObj<ChatpaneArgs>;

export const Wide: Story = { args: { narrow: false } };
export const Narrow: Story = { args: { narrow: true } };

/**
 * Wide layout in dark mode — the column establishes `color: var(--ink)` (the
 * prototype's body-text cascade), so the agent prose resolves to the bright
 * dark-mode `--ink` for strong contrast against the dark `--bg`.
 */
export const Dark: Story = {
  args: { narrow: false },
  globals: { theme: 'dark' },
};
