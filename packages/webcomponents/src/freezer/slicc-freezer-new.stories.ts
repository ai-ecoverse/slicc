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

export const Collapsed: Story = { args: { expanded: false } };

export const Expanded: Story = { args: { expanded: true } };

export const MultipleCones: Story = { args: { expanded: true, cones: 2 } };

export const SingleCone: Story = { args: { expanded: true, cones: 1 } };

export const TwoOutcome: Story = { args: { expanded: true, noSkip: true, cones: 2 } };

export const Busy: Story = { args: { expanded: true, busy: true, cones: 2 } };

export const CustomLabel: Story = { args: { expanded: false, label: 'Start fresh' } };

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

export const CollapsedIconOnly: Story = { args: { expanded: false } };
