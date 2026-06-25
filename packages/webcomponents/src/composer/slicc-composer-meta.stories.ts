import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-composer-meta.js';

interface MetaArgs {
  model?: string;
  thinking?: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
      options: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      description:
        'Thinking effort level (dropdown): Secco · Goccia · Bagnato · Affogato · Inzuppato · Sprofondato',
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
 * stroke), `max` thinking (`Sprofondato` — lucide `brain` tinted full violet,
 * violet border), each pill capped by a lucide `chevron-down` caret, and the
 * full keyboard hint. Click the model pill to fire `model-change`; click the
 * thinking pill to open the effort-level dropdown. No glyph is an emoji or bespoke
 * unicode symbol.
 */
export const Default: Story = { args: { model: 'Opus 4.8', thinking: 'max' } };

/** The deepest effort (`max` / `Sprofondato`) — full-violet brain + violet border. */
export const ThinkingActive: Story = { args: { model: 'Opus 4.8', thinking: 'max' } };

/** A mid effort (`medium` / `Bagnato`) — the brain is half-tinted, plain border. */
export const ThinkingDefault: Story = { args: { model: 'Opus 4.8', thinking: 'medium' } };

/** Bone dry (`off` / `Secco`) — the brain glyph is muted (`--txt-3`), no tint. */
export const ThinkingOff: Story = { args: { model: 'Opus 4.8', thinking: 'off' } };

/** A different model label at a low effort (`low` / `Goccia`). */
export const AltModel: Story = { args: { model: 'Sonnet 4.8', thinking: 'low' } };

/** Narrow chat column — the keyboard hint is hidden, leaving only the two pills. */
export const Narrow: Story = { args: { model: 'Opus 4.8', thinking: 'max', narrow: true } };

/**
 * Intensity ramp — six rows, one per wetness level, so the brain-glyph tint
 * ramp (dry `--txt-3` → full `--violet`) is easy to eyeball top-to-bottom
 * against light/dark.
 */
export const IntensityRamp: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:16px;';
    for (const level of ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const row = document.createElement('slicc-composer-meta');
      row.setAttribute('model', 'Opus 4.8');
      row.setAttribute('thinking', level);
      row.setAttribute('narrow', '');
      wrap.append(row);
    }
    return wrap;
  },
};

/**
 * Glyph showcase — the row stripped to its two pills so the lucide `sparkles`
 * (rainbow-stroked) and `brain` (tinted) icons, plus the `chevron-down` carets,
 * are easy to eyeball against light/dark. Cycle the thinking pill to confirm the
 * brain glyph stays a real `<svg>` across every effort level.
 */
export const IconShowcase: Story = {
  args: { model: 'Opus 4.8', thinking: 'medium', narrow: true },
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
    row.setAttribute('thinking', 'max');

    wrap.append(card, row);
    return wrap;
  },
};

/**
 * The model dropdown across many providers — rows show model + provider, and the
 * long list grows a type-ahead search (filter by model name or provider). Click
 * "Opus 4.8" to open it; it pops UP from the bottom-anchored row.
 */
export const ModelDropdown: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'min-height:420px;display:flex;align-items:flex-end;padding:16px;';
    const row = document.createElement('slicc-composer-meta') as HTMLElement & { models?: unknown };
    row.setAttribute('model', 'Opus 4.8');
    (row as { models?: unknown }).models = [
      { name: 'Opus 4.8', provider: 'Anthropic', id: 'claude-opus-4-8' },
      { name: 'Sonnet 4.6', provider: 'Anthropic', id: 'claude-sonnet-4-6' },
      { name: 'Haiku 4.5', provider: 'Anthropic', id: 'claude-haiku-4-5' },
      { name: 'GPT-5', provider: 'OpenAI', id: 'gpt-5' },
      { name: 'GPT-5 mini', provider: 'OpenAI', id: 'gpt-5-mini' },
      { name: 'o4', provider: 'OpenAI', id: 'o4' },
      { name: 'Gemini 2.5 Pro', provider: 'Google', id: 'gemini-2.5-pro' },
      { name: 'Gemini 2.5 Flash', provider: 'Google', id: 'gemini-2.5-flash' },
      { name: 'Firefly Image 4', provider: 'Adobe', id: 'firefly-image-4' },
    ];
    wrap.append(row);
    return wrap;
  },
};
