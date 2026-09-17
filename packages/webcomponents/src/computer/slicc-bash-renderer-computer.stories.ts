import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccBashRendererComputer } from './slicc-bash-renderer-computer.js';
import './slicc-bash-renderer-computer.js';

function shot(label: string, hue: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${hue}"/><stop offset="1" stop-color="#0a0a0a"/>` +
    `</linearGradient></defs><rect width="320" height="200" fill="url(#g)"/>` +
    `<text x="16" y="180" font-family="sans-serif" font-size="15" fill="#fff">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function renderer(opts: {
  command: string;
  output?: string;
  mode: 'live' | 'frozen' | 'none';
  frame?: string;
}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'padding:24px;background:#141414;color:#f2f2f2;font-family:var(--mono,ui-monospace,monospace);' +
    'border-radius:12px;max-width:420px;';
  const el = document.createElement('slicc-bash-renderer-computer') as SliccBashRendererComputer;
  el.command = opts.command;
  el.output = opts.output ?? '';
  el.toolCallId = 'story';
  el.done = true;
  el.frameMode = opts.mode;
  el.frameSrc = opts.frame ?? null;
  wrap.appendChild(el);
  return wrap;
}

const meta: Meta = {
  title: 'Computer/Bash Renderer',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/** Live frame — the newest invocation, computer still connected. */
export const Live: Story = {
  render: () =>
    renderer({
      command: 'computer watch -c jsh:fake',
      output: 'watching jsh:fake at 2 fps',
      mode: 'live',
      frame: shot('live', '#22c55e'),
    }),
};

/** Frozen still from a previous invocation. */
export const Frozen: Story = {
  render: () =>
    renderer({
      command: 'computer -c jsh:fake click 1',
      output: 'screen: /tmp/computer/jsh:fake/12.jpg',
      mode: 'frozen',
      frame: shot('frozen', '#737373'),
    }),
};

/** Command output only — no screen path and not the live row. */
export const None: Story = {
  render: () =>
    renderer({
      command: 'computer ls',
      output: 'jsh:fake   live   720×1280',
      mode: 'none',
    }),
};
