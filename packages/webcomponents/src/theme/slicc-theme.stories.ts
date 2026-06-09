import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-theme.js';

interface ThemeArgs {
  theme: 'light' | 'dark';
}

/**
 * A small slotted demo subtree so the provider's effect is visible: a tinted
 * surface (`--canvas` / `--line`) with body text (`--ink`), muted text
 * (`--txt-2`), and a fixed rainbow swatch (`--rainbow`) that must NOT change
 * between light and dark.
 */
function demoSubtree(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'padding:16px;border-radius:12px;background:var(--canvas);border:1px solid var(--line);font-family:var(--ui);color:var(--ink);max-width:320px;';
  wrap.innerHTML = `
    <div style="font-weight:600;font-size:14px;letter-spacing:-.02em;">sliccy theme provider</div>
    <p style="margin:8px 0 0;font-size:13px;color:var(--txt-2);">
      Neutral surface tokens flip; hue tokens stay fixed.
    </p>
    <div style="margin-top:12px;height:10px;border-radius:9999px;background:var(--rainbow);"></div>
  `;
  return wrap;
}

const meta: Meta<ThemeArgs> = {
  title: 'Theme/ThemeProvider',
  component: 'slicc-theme',
  tags: ['autodocs'],
  argTypes: {
    theme: {
      control: { type: 'inline-radio' },
      options: ['light', 'dark'],
      description: 'Theme applied to the provider and its subtree',
    },
  },
  render: ({ theme }) => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', theme);
    el.appendChild(demoSubtree());
    return el;
  },
};

export default meta;
type Story = StoryObj<ThemeArgs>;

/** Light is the prototype `:root` default. */
export const Light: Story = { args: { theme: 'light' } };

/** Dark re-defines the neutral surface tokens (prototype `body.dark`). */
export const Dark: Story = { args: { theme: 'dark' } };
