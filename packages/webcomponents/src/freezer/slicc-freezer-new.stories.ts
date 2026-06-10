import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { iconEl } from '../internal/icons.js';
import './slicc-freezer-new.js';

interface FreezerNewArgs {
  expanded?: boolean;
  label?: string;
}

/**
 * Wrap the affordance in a narrow rail-like container so collapsed vs expanded
 * geometry reads the way it does in the real freezer sidebar. The container is
 * presentational only — the component itself is self-contained.
 */
function railFrame(el: HTMLElement, expanded: boolean): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText = `width:${
    expanded ? '260px' : '44px'
  };padding:11px 8px;background:color-mix(in srgb, var(--ctx) 12%, var(--bg));border-right:1px solid var(--line);box-sizing:border-box;`;
  frame.appendChild(el);
  return frame;
}

const meta: Meta<FreezerNewArgs> = {
  title: 'Freezer/FreezerNew',
  component: 'slicc-freezer-new',
  tags: ['autodocs'],
  argTypes: {
    expanded: { control: 'boolean', description: 'Reveal the fading "New chat" label' },
    label: { control: 'text', description: 'Label text / accessible name (default "New chat")' },
  },
  render: ({ expanded, label }) => {
    const el = document.createElement('slicc-freezer-new');
    if (expanded) el.setAttribute('expanded', '');
    if (label) el.setAttribute('label', label);
    el.addEventListener('new-session', () => {
      // eslint-disable-next-line no-console
      console.log('new-session');
    });
    return railFrame(el, Boolean(expanded));
  },
};

export default meta;
type Story = StoryObj<FreezerNewArgs>;

/** Collapsed — icon-only, the label collapsed to zero width (rail at rest). */
export const Collapsed: Story = { args: { expanded: false } };

/** Expanded — the "New chat" label fades in beside the context-tinted badge. */
export const Expanded: Story = { args: { expanded: true } };

/** Hover — ghost background, surfaced via the global Pseudo States toolbar. */
export const Hover: Story = {
  args: { expanded: true },
  parameters: { pseudo: { hover: true } },
};

/** Custom label text (also overridable via the default slot). */
export const CustomLabel: Story = { args: { expanded: true, label: 'Start fresh' } };

/**
 * Custom glyph — the named `icon` slot overrides the default lucide `square-pen`
 * with another lucide icon (here `plus`), demonstrating the slot escape hatch
 * while keeping the context-tinted badge.
 */
export const CustomIcon: Story = {
  render: () => {
    const el = document.createElement('slicc-freezer-new');
    el.setAttribute('expanded', '');
    el.setAttribute('label', 'New chat');
    const icon = document.createElement('span');
    icon.slot = 'icon';
    icon.appendChild(iconEl('plus', { size: 16 }));
    el.appendChild(icon);
    return railFrame(el, true);
  },
};

/**
 * Collapsed rail with the lucide glyph centered in the badge — the icon-only
 * resting state, mirrored against the expanded states above for review.
 */
export const CollapsedIconOnly: Story = { args: { expanded: false } };
