import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-press-button.js';

interface PressButtonArgs {
  label?: string;
  tooltip?: string;
  disabled?: boolean;
  disableDoubleClick?: boolean;
  longPressMs?: number;
}

/** A small inline SVG glyph used as the button's slotted icon content. */
function gearIcon(): string {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
}

/**
 * Build a rail-style press button: a 32px square, rounded, bordered well that
 * carries the host's sizing/state (matching how the webapp rail items size the
 * component) so the ripple fills exactly what the user perceives as the button.
 */
function buildButton(args: PressButtonArgs): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:flex-start;gap:10px;font-family:var(--ui);color:var(--ink);';

  const btn = document.createElement('slicc-press-button');
  btn.style.cssText =
    'width:36px;height:36px;border:1px solid var(--line);border-radius:10px;color:var(--ink);cursor:pointer;';
  if (args.label) btn.setAttribute('label', args.label);
  if (args.tooltip) btn.setAttribute('tooltip', args.tooltip);
  if (args.disabled) btn.setAttribute('disabled', '');
  if (args.disableDoubleClick) btn.setAttribute('disable-double-click', '');
  if (args.longPressMs != null) btn.setAttribute('long-press-ms', String(args.longPressMs));
  btn.innerHTML = gearIcon();

  const status = document.createElement('code');
  status.style.cssText =
    'font-family:var(--mono);font-size:12px;color:var(--txt-2);min-height:1em;';
  status.textContent = 'press, double-click, or hold…';

  for (const type of ['short-click', 'double-click', 'long-press'] as const) {
    btn.addEventListener(type, () => {
      status.textContent = `${type} @ ${new Date().toLocaleTimeString()}`;
    });
  }

  wrap.append(btn, status);
  return wrap;
}

const meta: Meta<PressButtonArgs> = {
  title: 'Primitives/PressButton',
  component: 'slicc-press-button',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'aria-label forwarded to the inner button' },
    tooltip: { control: 'text', description: 'data-tooltip forwarded to the inner button' },
    disabled: { control: 'boolean', description: 'Disables the inner button' },
    disableDoubleClick: {
      control: 'boolean',
      description: 'Fire short-click immediately without waiting for a second click',
    },
    longPressMs: { control: 'number', description: 'Long-press threshold (ms)' },
  },
  render: (args) => buildButton(args),
};

export default meta;
type Story = StoryObj<PressButtonArgs>;

export const Default: Story = {
  args: { label: 'Settings', tooltip: 'Open settings' },
};

export const Disabled: Story = {
  args: { label: 'Settings', tooltip: 'Open settings', disabled: true },
};

export const NoDoubleClick: Story = {
  args: { label: 'Copy', tooltip: 'Copy response', disableDoubleClick: true },
};

export const FastLongPress: Story = {
  args: { label: 'Hold me', tooltip: 'Hold for the secondary action', longPressMs: 400 },
};
