import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-icon-button.js';

interface IconButtonArgs {
  icon?: string;
  label?: string;
  disabled?: boolean;
}

function build({ icon, label, disabled }: IconButtonArgs): HTMLElement {
  const el = document.createElement('slicc-icon-button');
  if (icon) el.setAttribute('icon', icon);
  if (label) el.setAttribute('label', label);
  if (disabled) el.setAttribute('disabled', '');
  return el;
}

/** A labelled row of icon buttons (used by the gallery story). */
function row(items: Array<{ icon: string; label: string }>): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '10px';
  wrap.style.alignItems = 'center';
  for (const { icon, label } of items) wrap.appendChild(build({ icon, label }));
  return wrap;
}

const meta: Meta<IconButtonArgs> = {
  title: 'Primitives/IconButton',
  component: 'slicc-icon-button',
  tags: ['autodocs'],
  argTypes: {
    icon: { control: 'text', description: 'Lucide icon name (kebab-case, default `plus`)' },
    label: { control: 'text', description: 'Accessible name (aria-label + title)' },
    disabled: { control: 'boolean', description: 'Non-interactive, dimmed state' },
  },
  render: build,
};

export default meta;
type Story = StoryObj<IconButtonArgs>;

/** Default state — the `plus` lucide glyph. */
export const Default: Story = { args: { icon: 'plus', label: 'Add' } };

/** Each named lucide icon the prototype toolbars use. */
export const Plus: Story = { args: { icon: 'plus', label: 'Add' } };
export const Paperclip: Story = { args: { icon: 'paperclip', label: 'Attach' } };
export const Settings: Story = { args: { icon: 'settings', label: 'Settings' } };
export const Search: Story = { args: { icon: 'search', label: 'Search' } };
export const Mic: Story = { args: { icon: 'mic', label: 'Record' } };

/** Non-interactive, dimmed. */
export const Disabled: Story = { args: { icon: 'plus', label: 'Add', disabled: true } };

/** The toolbar icon set side by side (icons inherit idle/hover/disabled color). */
export const Gallery: Story = {
  render: () =>
    row([
      { icon: 'plus', label: 'Add' },
      { icon: 'paperclip', label: 'Attach' },
      { icon: 'settings', label: 'Settings' },
      { icon: 'search', label: 'Search' },
      { icon: 'mic', label: 'Record' },
    ]),
};

/** A slotted custom `<svg>` overrides the lucide `icon` entirely. */
export const CustomSvgOverride: Story = {
  render: ({ label }) => {
    const el = document.createElement('slicc-icon-button');
    if (label) el.setAttribute('label', label);
    // `icon` is ignored because the default slot is populated.
    el.setAttribute('icon', 'plus');
    el.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/></svg>';
    return el;
  },
  args: { label: 'Confirm' },
};
