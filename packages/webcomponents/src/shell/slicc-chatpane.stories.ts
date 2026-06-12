import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-chat-thread.js';
import '../chat/slicc-user-message.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-input-card.js';
import '../freezer/slicc-shader.js';
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
 * Narrow view with a freezer / scoop that has LITTLE history. The thread inner
 * carries a viewport-based min-height (100dvh), so even with a single message it
 * fills to the bottom of the screen — no abrupt end leaving empty space below.
 * Rendered full-bleed (no fixed frame) so the viewport fill is visible.
 */
function shortHistory(): HTMLElement {
  const pane = document.createElement('slicc-chatpane');
  pane.setAttribute('narrow', '');
  pane.style.cssText = 'width:340px;border-right:1px solid var(--line);';

  const thread = document.createElement('slicc-chat-thread');
  const a = document.createElement('slicc-agent-message');
  a.innerHTML = '<p>Freshly thawed — nothing in this scoop yet.</p>';
  thread.append(a);

  const composer = document.createElement('slicc-composer');
  composer.innerHTML = '<slicc-input-card></slicc-input-card>';

  pane.append(thread, composer);
  return pane;
}

export const NarrowShortHistory: Story = {
  args: { narrow: true },
  render: () => shortHistory(),
};

/**
 * Wide layout in dark mode — the column establishes `color: var(--ink)` (the
 * prototype's body-text cascade), so the agent prose resolves to the bright
 * dark-mode `--ink` for strong contrast against the dark `--bg`.
 */
export const Dark: Story = {
  args: { narrow: false },
  globals: { theme: 'dark' },
};

/**
 * The reading card over the live shader. A `<slicc-shader>` fills the frame
 * behind the pane; the pane host is made see-through here (story-only) so the
 * shader reaches the column, where the wide `.slicc-thread__inner` now carries a
 * translucent frosted fill — the shader SHIMMERS THROUGH the card while the
 * backdrop blur + tint keep the agent / user prose readable.
 */
function overShader(): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'position:relative;display:flex;height:520px;width:880px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);';

  const shader = document.createElement('slicc-shader');
  shader.setAttribute('mode', 'scoop');
  shader.setAttribute('tint', '#ef7000');
  shader.style.cssText = 'position:absolute;inset:0;z-index:0;';
  frame.appendChild(shader);

  const pane = document.createElement('slicc-chatpane');
  // Story-only: let the shader behind reach the translucent reading card.
  pane.style.cssText = 'position:relative;z-index:1;background:transparent;';

  const thread = document.createElement('slicc-chat-thread');
  const u = document.createElement('slicc-user-message');
  u.textContent = 'Make the freezer background frost slowly.';
  const a = document.createElement('slicc-agent-message');
  a.append(
    Object.assign(document.createElement('p'), {
      textContent: 'On it — wiring the frost shader into the freezer rail now.',
    })
  );
  thread.append(u, a);

  const composer = document.createElement('slicc-composer');
  composer.append(document.createElement('slicc-input-card'));

  pane.append(thread, composer);
  frame.appendChild(pane);
  return frame;
}

export const OverShader: Story = {
  args: { narrow: false },
  render: () => overShader(),
};
