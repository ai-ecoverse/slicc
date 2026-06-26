import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { SliccQuickLook } from './slicc-quick-look.js';

function buildStory(opts: {
  path: string;
  content: string | ArrayBuffer;
  mimeType: string;
}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:40px;font-family:var(--ui);';

  const btn = document.createElement('button');
  btn.textContent = `Preview: ${opts.path.split('/').pop()}`;
  btn.style.cssText = 'padding:8px 14px;font-size:13px;cursor:pointer;';
  btn.addEventListener('click', () => SliccQuickLook.open(opts));
  wrap.appendChild(btn);

  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top:8px;font-size:12px;color:var(--txt-3);';
  hint.textContent = 'Click button to open Quick Look overlay';
  wrap.appendChild(hint);
  return wrap;
}

const SAMPLE_CODE = `import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

export class SliccExample extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }
  connectedCallback() {
    this.shadowRoot!.append(h('div', { class: 'root' }, 'Hello'));
  }
}

define('slicc-example', SliccExample);
`;

const LONG_TEXT = Array.from(
  { length: 100 },
  (_, i) => `Line ${i + 1}: ${'lorem ipsum '.repeat(8)}`
).join('\n');

const meta: Meta = {
  title: 'QuickLook/QuickLook',
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

export const TextShort: Story = {
  render: () =>
    buildStory({
      path: '/workspace/example.ts',
      content: SAMPLE_CODE,
      mimeType: 'text/typescript',
    }),
};

export const TextLong: Story = {
  render: () =>
    buildStory({ path: '/workspace/log.txt', content: LONG_TEXT, mimeType: 'text/plain' }),
};

export const ImageLandscape: Story = {
  render: () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#8b5cf6';
    ctx.fillRect(0, 0, 400, 200);
    ctx.fillStyle = '#fff';
    ctx.font = '24px sans-serif';
    ctx.fillText('Landscape', 140, 110);
    return new Promise<HTMLElement>((resolve) => {
      canvas.toBlob((blob) => {
        blob!.arrayBuffer().then((buf) => {
          resolve(
            buildStory({ path: '/workspace/landscape.png', content: buf, mimeType: 'image/png' })
          );
        });
      });
    }) as unknown as HTMLElement;
  },
};

export const ImagePortrait: Story = {
  render: () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#059669';
    ctx.fillRect(0, 0, 200, 400);
    ctx.fillStyle = '#fff';
    ctx.font = '20px sans-serif';
    ctx.fillText('Portrait', 50, 210);
    return new Promise<HTMLElement>((resolve) => {
      canvas.toBlob((blob) => {
        blob!.arrayBuffer().then((buf) => {
          resolve(
            buildStory({ path: '/workspace/portrait.png', content: buf, mimeType: 'image/png' })
          );
        });
      });
    }) as unknown as HTMLElement;
  },
};

export const Audio: Story = {
  render: () =>
    buildStory({
      path: '/workspace/clip.mp3',
      content: new ArrayBuffer(0),
      mimeType: 'audio/mpeg',
    }),
};

export const Video: Story = {
  render: () =>
    buildStory({ path: '/workspace/demo.mp4', content: new ArrayBuffer(0), mimeType: 'video/mp4' }),
};

export const UnknownType: Story = {
  render: () =>
    buildStory({
      path: '/workspace/data.bin',
      content: new ArrayBuffer(2048),
      mimeType: 'application/octet-stream',
    }),
};
