import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-soundboard.js';

function render(): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'display:flex;flex-direction:column;gap:12px;padding:24px;font-family:var(--ui);color:var(--ink);background:var(--bg);';

  const caption = document.createElement('p');
  caption.style.cssText = 'margin:0;color:var(--txt-2);font-size:12px;max-width:520px;';
  caption.textContent =
    'Manual audition surface for the voice-mode soundscape cues. Clicking a button produces real audio (the click satisfies the WebAudio user-gesture requirement).';

  const board = document.createElement('slicc-soundboard');
  frame.append(caption, board);
  return frame;
}

const meta: Meta = {
  title: 'Audio/Soundboard',
  component: 'slicc-soundboard',
  tags: ['autodocs'],
  render,
};

export default meta;
type Story = StoryObj;

export const Default: Story = {};
