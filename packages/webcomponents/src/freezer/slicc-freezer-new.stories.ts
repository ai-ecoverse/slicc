import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { iconEl } from '../internal/icons.js';
import './slicc-freezer-new.js';

interface FreezerNewArgs {
  expanded?: boolean;
  label?: string;
  busy?: boolean;
  noSkip?: boolean;
  cones?: number;
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
    busy: { control: 'boolean', description: 'Spinning loader glyph (work-in-progress state)' },
    noSkip: {
      control: 'boolean',
      description: 'Two-outcome mode: hide the fast action, short click saves immediately',
    },
    cones: {
      control: 'number',
      description: 'Cone count: absent hides the cone actions, >1 also shows drop-cone',
    },
  },
  render: ({ expanded, label, busy, noSkip, cones }) => {
    const el = document.createElement('slicc-freezer-new');
    if (expanded) el.setAttribute('expanded', '');
    if (label) el.setAttribute('label', label);
    if (busy) el.setAttribute('busy', '');
    if (noSkip) el.setAttribute('no-skip', '');
    if (typeof cones === 'number') el.setAttribute('cones', String(cones));
    // The three-state gesture (single / double / long-press) + the expanded
    // row buttons all surface as distinct events — log each for review.
    for (const type of [
      'new-chat-save',
      'new-chat-skip',
      'new-chat-erase',
      'new-cone',
      'drop-cone',
    ]) {
      el.addEventListener(type, () => {
        // eslint-disable-next-line no-console
        console.log(type);
      });
    }
    return railFrame(el, Boolean(expanded));
  },
};

export default meta;
type Story = StoryObj<FreezerNewArgs>;

/** Collapsed — icon-only, the label collapsed to zero width (rail at rest). */
export const Collapsed: Story = { args: { expanded: false } };

/**
 * Expanded — the gesture badge gives way to one row of icon buttons (save /
 * fast / discard), each with a tooltip. The row is always present at a fixed
 * height: nothing is revealed on hover, so the rail never shifts (#2272).
 */
export const Expanded: Story = { args: { expanded: true } };

/**
 * Multiple cones — the host reports `cones`, so the row also offers new-cone;
 * with more than one cone it offers drop-cone as well.
 */
export const MultipleCones: Story = { args: { expanded: true, cones: 2 } };

/** One cone — new-cone is offered, drop-cone is not (the last cone stays). */
export const SingleCone: Story = { args: { expanded: true, cones: 1 } };

/**
 * Two-outcome mode (`no-skip`) — used when a background memory curator owns
 * the memory decision (agentic memory): the row reduces to save and discard,
 * and a collapsed short click saves immediately with no double-click window.
 */
export const TwoOutcome: Story = { args: { expanded: true, noSkip: true, cones: 2 } };

/**
 * Busy — the work-in-progress state entered on a save click (or driven by the
 * host via the `busy` attribute): the save badge's glyph swaps to a spinning
 * lucide loader for immediate feedback before the save + reload completes. The
 * spin is held static under `prefers-reduced-motion: reduce`.
 */
export const Busy: Story = { args: { expanded: true, busy: true, cones: 2 } };

/** Custom label text (collapsed badge; also overridable via the default slot). */
export const CustomLabel: Story = { args: { expanded: false, label: 'Start fresh' } };

/**
 * Custom glyph — the named `icon` slot overrides the default lucide `square-pen`
 * with another lucide icon (here `plus`), demonstrating the slot escape hatch
 * while keeping the context-tinted badge.
 */
export const CustomIcon: Story = {
  render: () => {
    const el = document.createElement('slicc-freezer-new');
    el.setAttribute('label', 'New chat');
    const icon = document.createElement('span');
    icon.slot = 'icon';
    icon.appendChild(iconEl('plus', { size: 16 }));
    el.appendChild(icon);
    return railFrame(el, false);
  },
};

/**
 * Collapsed rail with the lucide glyph centered in the badge — the icon-only
 * resting state, mirrored against the expanded states above for review.
 */
export const CollapsedIconOnly: Story = { args: { expanded: false } };
