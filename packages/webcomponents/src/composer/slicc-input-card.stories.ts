import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-input-card.js';

interface InputCardArgs {
  value?: string;
  placeholder?: string;
  suggestion?: string;
  disabled?: boolean;
}

/**
 * Wrap the card in a 680px composer-width band on the off-white `--bg` so the
 * white card reads as "lifted" exactly as it does in the prototype composer.
 */
function inComposer(card: HTMLElement): HTMLElement {
  const band = document.createElement('div');
  band.style.background = 'var(--bg)';
  band.style.padding = '14px 16px';
  const inner = document.createElement('div');
  inner.style.maxWidth = '680px';
  inner.style.margin = '0 auto';
  inner.appendChild(card);
  band.appendChild(inner);
  return band;
}

function buildCard({ value, placeholder, suggestion, disabled }: InputCardArgs): HTMLElement {
  const el = document.createElement('slicc-input-card');
  if (value != null) el.setAttribute('value', value);
  if (placeholder != null) el.setAttribute('placeholder', placeholder);
  if (suggestion != null) el.setAttribute('suggestion', suggestion);
  if (disabled) el.setAttribute('disabled', '');
  return el;
}

const meta: Meta<InputCardArgs> = {
  title: 'Composer/InputCard',
  component: 'slicc-input-card',
  tags: ['autodocs'],
  argTypes: {
    value: { control: 'text', description: 'Textarea contents' },
    placeholder: { control: 'text', description: 'Textarea placeholder' },
    suggestion: {
      control: 'text',
      description: 'Suggested follow-up shown as the placeholder; Tab accepts it',
    },
    disabled: { control: 'boolean', description: 'Disable the textarea' },
  },
  render: (args) => inComposer(buildCard(args)),
};

export default meta;
type Story = StoryObj<InputCardArgs>;

/** Idle — empty card with the default add-menu + send-button toolbar. */
export const Idle: Story = { args: {} };

/**
 * Focus-within highlight — the violet border + 3px focus ring. The textarea is
 * autofocused so the card paints its `:focus-within` state on load.
 */
export const FocusWithin: Story = {
  args: {},
  render: (args) => {
    const band = inComposer(buildCard(args));
    requestAnimationFrame(() => band.querySelector('slicc-input-card')?.focus());
    return band;
  },
};

/** Typed single line — short text, card still at its min height. */
export const SingleLine: Story = {
  args: { value: 'Make the hero headline warmer and bump the CTA contrast.' },
};

/**
 * Multi-line autosize — enough text that the textarea has grown toward its
 * 140px max (then it scrolls).
 */
export const MultiLine: Story = {
  args: {
    value:
      'Audit the cold hero section.\n' +
      'Redesign it in a live sprinkle.\n' +
      'Verify before/after in the browser.\n' +
      'Open a PR and file a tracking ticket.\n' +
      'Then triage the support lick that just came in.',
  },
};

/** Custom placeholder copy. */
export const CustomPlaceholder: Story = {
  args: { placeholder: 'Describe the change you want…' },
};

/**
 * Suggested follow-up — an LLM-proposed next prompt on the `suggestion`
 * attribute: shown as the placeholder of the empty composer, and Tab accepts
 * it into the textarea (instead of tabbing focus to the + menu) so Enter can
 * submit it. Focus the textarea and press Tab to try it.
 */
export const SuggestedFollowUp: Story = {
  args: { suggestion: 'Now add dark mode to the hero?' },
};

/** Disabled — textarea is non-interactive (e.g. while a turn is streaming). */
export const Disabled: Story = { args: { disabled: true } };

/**
 * Custom toolbar via the `toolbar` slot — a bare send button only, no add-menu.
 * Shows that hosts can fully replace the default controls.
 */
export const CustomToolbar: Story = {
  args: {},
  render: (args) => {
    const card = buildCard(args);
    const send = document.createElement('slicc-send-button');
    send.setAttribute('slot', 'toolbar');
    const spacer = document.createElement('div');
    spacer.setAttribute('slot', 'toolbar');
    spacer.style.flex = '1';
    card.append(spacer, send);
    return inComposer(card);
  },
};
