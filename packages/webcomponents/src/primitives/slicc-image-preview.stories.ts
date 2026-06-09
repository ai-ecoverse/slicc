import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-image-preview.js';
import type { SliccImagePreview } from './slicc-image-preview.js';

/**
 * A 1×1 transparent PNG scaled up by the thumbnail box would be ugly, so the
 * stories use a small inline SVG data URL with real intrinsic dimensions — the
 * FLIP zoom needs a `naturalWidth`/`naturalHeight` to compute the final rect.
 */
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f59e0b"/>
      <stop offset="0.5" stop-color="#ec4899"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect width="640" height="400" fill="url(#g)"/>
  <circle cx="320" cy="200" r="120" fill="#fff" fill-opacity="0.85"/>
  <text x="320" y="215" font-family="ui-sans-serif,system-ui,sans-serif" font-size="48"
        font-weight="600" text-anchor="middle" fill="#0a0a0a">sliccy</text>
</svg>`;
const SAMPLE_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(SAMPLE_SVG)}`;

interface PreviewArgs {
  /** Whether the lightbox is open as the story mounts. */
  startOpen?: boolean;
}

const meta: Meta<PreviewArgs> = {
  title: 'Primitives/ImagePreview',
  component: 'slicc-image-preview',
  tags: ['autodocs'],
  argTypes: {
    startOpen: {
      control: 'boolean',
      description: 'Open the lightbox immediately when the story renders',
    },
  },
  parameters: {
    docs: {
      description: {
        component:
          'FLIP-zoom image lightbox. A thumbnail FLIP-zooms up to a centred, ' +
          'viewport-fitted preview on click and animates back on dismiss ' +
          '(click / Escape). The dark scrim is intentional chrome — it reads the ' +
          'same in light and dark mode.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<PreviewArgs>;

/** Build the clickable thumbnail + a co-located preview host. */
function thumbnailDemo(startOpen: boolean): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:40px;font-family:var(--ui,system-ui,sans-serif);color:var(--ink);';

  const caption = document.createElement('p');
  caption.textContent = 'Click the thumbnail to zoom. Click anywhere or press Escape to dismiss.';
  caption.style.cssText = 'margin:0 0 16px;font-size:13px;color:var(--txt-2,#737373);';
  wrap.appendChild(caption);

  const thumb = document.createElement('img');
  thumb.src = SAMPLE_SRC;
  thumb.alt = 'Thumbnail';
  thumb.style.cssText =
    'width:96px;height:60px;object-fit:cover;border-radius:6px;cursor:zoom-in;' +
    'border:1px solid var(--line,#e5e5e5);display:block;';
  wrap.appendChild(thumb);

  const preview = document.createElement('slicc-image-preview') as SliccImagePreview;
  wrap.appendChild(preview);

  thumb.addEventListener('click', () => preview.open(SAMPLE_SRC, thumb));

  if (startOpen) {
    // Defer so the thumbnail has a layout rect for the FLIP origin.
    requestAnimationFrame(() => preview.open(SAMPLE_SRC, thumb));
  }

  return wrap;
}

/** The resting state: a thumbnail that opens the lightbox on click. */
export const Thumbnail: Story = {
  args: { startOpen: false },
  render: ({ startOpen }) => thumbnailDemo(!!startOpen),
};

/** The lightbox shown open — the centred, viewport-fitted, scrimmed preview. */
export const Open: Story = {
  args: { startOpen: true },
  render: ({ startOpen }) => thumbnailDemo(startOpen !== false),
};

/** The static `SliccImagePreview.show(src, originEl)` helper, mirroring `showImagePreview`. */
export const StaticHelper: Story = {
  args: {},
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'padding:40px;font-family:var(--ui,system-ui,sans-serif);color:var(--ink);';

    const btn = document.createElement('button');
    btn.textContent = 'Open via SliccImagePreview.show()';
    btn.style.cssText =
      'font:inherit;font-size:13px;font-weight:500;color:var(--ink);background:var(--canvas,#fff);' +
      'border:1px solid var(--line,#e5e5e5);border-radius:9999px;padding:7px 14px;cursor:pointer;';
    wrap.appendChild(btn);

    btn.addEventListener('click', () => {
      // Lazily import the class only here to mirror the runtime helper path.
      import('./slicc-image-preview.js').then(({ SliccImagePreview }) => {
        SliccImagePreview.show(SAMPLE_SRC, btn);
      });
    });

    return wrap;
  },
};
