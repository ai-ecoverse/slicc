import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { iconSvg } from '../internal/icons.js';
import './slicc-press-button.js';

interface PressButtonArgs {
  label?: string;
  tooltip?: string;
  disabled?: boolean;
  disableDoubleClick?: boolean;
  longPressMs?: number;
  /** lucide icon name rendered as the slotted glyph (kebab-case). */
  icon?: string;
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
  btn.innerHTML = iconSvg(args.icon ?? 'settings', { size: 18 });

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

/**
 * A larger, more demonstrative button with an instructions block — built to
 * make the click → squish and double-click → wobble delight animations easy to
 * trigger and observe in isolation. The status line names the last animation.
 */
function buildAnimationDemo(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:flex-start;gap:14px;font-family:var(--ui);color:var(--ink);max-width:320px;';

  const intro = document.createElement('p');
  intro.style.cssText = 'margin:0;font-size:13px;line-height:1.5;color:var(--txt-2);';
  intro.innerHTML =
    '<strong style="color:var(--ink)">Try it:</strong> a single <em>click</em> gives a quick tactile ' +
    '<strong>squish</strong>; a <em>double-click</em> triggers a distinct playful <strong>wobble</strong>. ' +
    'Hold for the secondary (long-press) action — that one stays calm. ' +
    'Animations are disabled automatically under <code>prefers-reduced-motion</code>.';

  const btn = document.createElement('slicc-press-button');
  btn.style.cssText =
    'width:64px;height:64px;border:1px solid var(--line);border-radius:16px;color:var(--ctx);cursor:pointer;';
  btn.setAttribute('label', 'Delight');
  btn.setAttribute('tooltip', 'Click, double-click, or hold');
  btn.innerHTML = iconSvg('sparkles', { size: 28 });

  const status = document.createElement('code');
  status.style.cssText =
    'font-family:var(--mono);font-size:12px;color:var(--txt-2);min-height:1em;';
  status.textContent = 'waiting for a press…';

  const labels: Record<string, string> = {
    'short-click': 'click → squish',
    'double-click': 'double-click → wobble',
    'long-press': 'long-press (no animation)',
  };
  for (const type of ['short-click', 'double-click', 'long-press'] as const) {
    btn.addEventListener(type, () => {
      status.textContent = `${labels[type]} @ ${new Date().toLocaleTimeString()}`;
    });
  }

  wrap.append(intro, btn, status);
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
    icon: { control: 'text', description: 'lucide icon name (kebab-case) for the slotted glyph' },
  },
  render: (args) => buildButton(args),
};

export default meta;
type Story = StoryObj<PressButtonArgs>;

export const Default: Story = {
  args: { label: 'Settings', tooltip: 'Open settings', icon: 'settings' },
};

export const Disabled: Story = {
  args: { label: 'Settings', tooltip: 'Open settings', icon: 'settings', disabled: true },
};

export const NoDoubleClick: Story = {
  args: { label: 'Copy', tooltip: 'Copy response', icon: 'copy', disableDoubleClick: true },
};

export const FastLongPress: Story = {
  args: {
    label: 'Hold me',
    tooltip: 'Hold for the secondary action',
    icon: 'hand',
    longPressMs: 400,
  },
};

/**
 * Click → squish, double-click → wobble. The standout story for the new
 * delight animations: a roomy button plus an instructions block so a reviewer
 * can trigger and tell the two animations apart at a glance.
 */
export const ClickAndDoubleClickAnimations: Story = {
  render: () => buildAnimationDemo(),
};
