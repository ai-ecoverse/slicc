import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-composer-meta.js';

interface MetaArgs {
  model?: string;
  thinking?: 'bambino' | 'piccolo' | 'grande' | 'bombastica';
  narrow?: boolean;
}

const meta: Meta<MetaArgs> = {
  title: 'Composer/ComposerMeta',
  component: 'slicc-composer-meta',
  tags: ['autodocs'],
  argTypes: {
    model: { control: 'text', description: 'Model label shown in the model pill' },
    thinking: {
      control: 'inline-radio',
      options: ['bambino', 'piccolo', 'grande', 'bombastica'],
      description: 'Thinking effort level (cycles on click)',
    },
    narrow: { control: 'boolean', description: 'Hide the keyboard hint (narrow chat column)' },
  },
  render: ({ model, thinking, narrow }) => {
    const el = document.createElement('slicc-composer-meta');
    if (model != null) el.setAttribute('model', model);
    if (thinking) el.setAttribute('thinking', thinking);
    if (narrow) el.setAttribute('narrow', '');
    return el;
  },
};

export default meta;
type Story = StoryObj<MetaArgs>;

/**
 * Default meta row — Opus 4.8 model pill (lucide `sparkles` glyph with a rainbow
 * stroke), `bombastica` thinking (lucide `brain`, violet border), each pill
 * capped by a lucide `chevron-down` caret, and the full keyboard hint. Click the
 * model pill to fire `model-change`; click the thinking pill to cycle the effort
 * level. No glyph is an emoji or bespoke unicode symbol.
 */
export const Default: Story = { args: { model: 'Opus 4.8', thinking: 'bombastica' } };

/** Non-default effort (`bombastica`) — the thinking pill shows the violet border. */
export const ThinkingActive: Story = { args: { model: 'Opus 4.8', thinking: 'bombastica' } };

/** A lower effort (`grande`) — the thinking pill uses the plain border. */
export const ThinkingDefault: Story = { args: { model: 'Opus 4.8', thinking: 'grande' } };

/** The smallest effort (`bambino`). */
export const ThinkingBambino: Story = { args: { model: 'Opus 4.8', thinking: 'bambino' } };

/** A different model label. */
export const AltModel: Story = { args: { model: 'Sonnet 4.8', thinking: 'piccolo' } };

/** Narrow chat column — the keyboard hint is hidden, leaving only the two pills. */
export const Narrow: Story = { args: { model: 'Opus 4.8', thinking: 'bombastica', narrow: true } };

/**
 * Glyph showcase — the row stripped to its two pills so the lucide `sparkles`
 * (rainbow-stroked) and `brain` (violet) icons, plus the `chevron-down` carets,
 * are easy to eyeball against light/dark. Cycle the thinking pill to confirm the
 * brain glyph stays a real `<svg>` across every effort level.
 */
export const IconShowcase: Story = {
  args: { model: 'Opus 4.8', thinking: 'grande', narrow: true },
};

/** A realistic composer context: the meta row beneath an input card. */
export const InComposer: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:712px;margin:0 auto;padding:16px;';

    const card = document.createElement('div');
    card.style.cssText =
      'border:1px solid var(--line);border-radius:16px;background:var(--canvas);' +
      'padding:14px 12px 10px 16px;color:var(--ink);font-family:var(--ui);' +
      'box-shadow:rgba(10,10,10,.05) 0 2px 12px -2px;max-width:680px;margin:0 auto;';
    card.textContent = 'Describe what you want shipped…';
    card.style.color = 'var(--txt-3)';

    const row = document.createElement('slicc-composer-meta');
    row.setAttribute('model', 'Opus 4.8');
    row.setAttribute('thinking', 'bombastica');

    wrap.append(card, row);
    return wrap;
  },
};
