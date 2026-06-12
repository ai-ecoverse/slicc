import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../memory/slicc-palette-cell.js';
import './slicc-dip.js';

interface DipArgs {
  name: string;
  hue: string;
  prompt: string;
}

const meta: Meta<DipArgs> = {
  title: 'Chat/Dip',
  component: 'slicc-dip',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'In-chat interactive "Sprinkle Dip" card. The frosted header chip (`::part(glyph)`) ' +
          'now renders a lucide `sparkles` <svg> (never the old ✦ glyph). Composes ' +
          '`<slicc-palette-cell>` swatches, runs a cursor-reactive sprinkle particle field ' +
          '(which no-ops under `prefers-reduced-motion: reduce`), and emits `slicc-dip-apply`.',
      },
    },
  },
  argTypes: {
    name: { control: 'text' },
    hue: { control: 'color' },
    prompt: { control: 'text' },
  },
  render: ({ name, hue, prompt }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;';
    const dip = document.createElement('slicc-dip');
    if (name) dip.setAttribute('name', name);
    if (hue) dip.setAttribute('hue', hue);
    if (prompt) dip.setAttribute('prompt', prompt);
    wrap.appendChild(dip);
    return wrap;
  },
};

export default meta;
type Story = StoryObj<DipArgs>;

/** Default dip — header chip is the lucide `sparkles` icon, default cone accent. */
export const Default: Story = { args: { name: 'palette.shtml' } };

/** Violet accent hue (`--c`) tinting the sparkles chip and the tag pill. */
export const VioletHue: Story = { args: { name: 'palette.shtml', hue: '#8b5cf6' } };

/** Cyan accent hue with a custom prompt line. */
export const CyanHue: Story = {
  args: { name: 'theme.shtml', hue: '#06b6d4', prompt: 'Pick a canvas and an accent:' },
};

/** Rose accent hue — verifies the sparkles chip + tag pick up any `hue`. */
export const RoseHue: Story = {
  args: { name: 'hero.shtml', hue: '#f43f5e', prompt: 'Dial in the rose hero palette:' },
};

/**
 * Focus state for the header glyph: zooms the `::part(glyph)` chip so the lucide
 * `sparkles` `<svg>` is clearly visible (and verifiably NOT an emoji glyph).
 */
export const SparklesChipDetail: Story = {
  args: { name: 'palette.shtml', hue: '#8b5cf6' },
  render: ({ name, hue }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;';
    const dip = document.createElement('slicc-dip');
    if (name) dip.setAttribute('name', name);
    if (hue) dip.setAttribute('hue', hue);
    // Magnify just the accent chip so the sparkles icon strokes are reviewable.
    const css = document.createElement('style');
    css.textContent =
      'slicc-dip.detail::part(glyph){width:48px;height:48px;border-radius:12px;}' +
      'slicc-dip.detail::part(glyph) svg{width:30px;height:30px;}';
    dip.className = 'detail';
    wrap.append(css, dip);
    return wrap;
  },
};

/**
 * Apply-event demo: clicking "Apply to hero →" emits the composed, bubbling
 * `slicc-dip-apply` carrying the chosen `{ canvas, accent }` swatches, echoed
 * below the card.
 */
export const ApplyEvent: Story = {
  args: { name: 'palette.shtml', hue: '#ef7000' },
  render: ({ name, hue, prompt }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;';
    const dip = document.createElement('slicc-dip');
    if (name) dip.setAttribute('name', name);
    if (hue) dip.setAttribute('hue', hue);
    if (prompt) dip.setAttribute('prompt', prompt);
    const out = document.createElement('pre');
    out.style.cssText =
      'margin:10px 0 0;font:12px/1.4 ui-monospace,monospace;color:var(--txt-2);white-space:pre-wrap;';
    out.textContent = 'slicc-dip-apply → (click Apply)';
    dip.addEventListener('slicc-dip-apply', (e) => {
      out.textContent = `slicc-dip-apply → ${JSON.stringify((e as CustomEvent).detail)}`;
    });
    wrap.append(dip, out);
    return wrap;
  },
};
