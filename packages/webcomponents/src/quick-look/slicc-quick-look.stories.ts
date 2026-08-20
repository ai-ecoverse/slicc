import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { type QuickLookOptions, SliccQuickLook } from './slicc-quick-look.js';

/**
 * Render the overlay immediately rather than behind a click.
 *
 * The PR screenshot job captures a story as it mounts, so a click-to-open story
 * photographs the button and never the preview. Stories that exist to show what
 * the preview LOOKS like open themselves.
 */
function buildOpenStory(opts: QuickLookOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:40px;font-family:var(--ui);min-height:520px;';
  // A frame's delay lets Storybook attach the theme scope before the overlay
  // reads its tokens.
  requestAnimationFrame(() => SliccQuickLook.open(opts));
  return wrap;
}

function buildStory(opts: QuickLookOptions): HTMLElement {
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
    const dataUrl = canvas.toDataURL('image/png');
    const binary = atob(dataUrl.split(',')[1]);
    const buf = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buildStory({ path: '/workspace/landscape.png', content: buf, mimeType: 'image/png' });
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
    const dataUrl = canvas.toDataURL('image/png');
    const binary = atob(dataUrl.split(',')[1]);
    const buf = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buildStory({ path: '/workspace/portrait.png', content: buf, mimeType: 'image/png' });
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

/**
 * A file whose extension no MIME table knows — the case that used to dead-end.
 *
 * The caller sniffed the bytes (`core/file-type.ts`) and passes `text: true`,
 * so `.jsh` previews as source instead of "Preview not available".
 */
export const UnknownExtension: Story = {
  render: () =>
    buildOpenStory({
      path: '/workspace/skills/slack/scripts/slack.jsh',
      content: `#!/usr/bin/env jsh
# post a message to a channel
set -e
channel="$1"; shift
curl -sS -X POST "$SLACK_API/chat.postMessage" \\
  -H "Authorization: Bearer $SLACK_TOKEN" \\
  -d "channel=$channel" -d "text=$*"
`,
      mimeType: 'text/plain',
      text: true,
    }),
};

/**
 * A file with uncommitted changes opens on its DIFF, because that is the
 * question a modified file poses. The header carries the git status and a
 * toggle back to the whole file.
 */
export const ModifiedFile: Story = {
  render: () =>
    buildOpenStory({
      path: '/repo/src/greeting.ts',
      content: `export function greet(name: string): string {
  return \`Hello, \${name}! Welcome back.\`;
}
`,
      mimeType: 'text/typescript',
      baseContent: `export function greet(name: string): string {
  return "Hello!";
}
`,
      gitStatus: 'modified',
    }),
};

const SAMPLE_MARKDOWN = `# Release notes

A **rendered** markdown preview, opened the way a reader wants it.

- Prose, lists and tables, not backticks and hashes
- The source is one click away in the header toggle

| Change | Status |
| --- | --- |
| Mention hints | done |
| Rich preview | done |

> Markdown arrives here already sanitized by the host.

\`\`\`ts
const answer = 42;
\`\`\`
`;

/**
 * Markdown opens RENDERED. The host converts it (the same sanitizing renderer
 * the transcript uses) and hands over the HTML; `Source` switches to the
 * markup, and the two live in the header toggle together.
 */
export const MarkdownRendered: Story = {
  render: () =>
    buildOpenStory({
      path: '/workspace/RELEASE.md',
      content: SAMPLE_MARKDOWN,
      mimeType: 'text/plain',
      text: true,
      rendered: {
        mount: 'inline',
        html: `<h1>Release notes</h1>
<p>A <strong>rendered</strong> markdown preview, opened the way a reader wants it.</p>
<ul><li>Prose, lists and tables, not backticks and hashes</li>
<li>The source is one click away in the header toggle</li></ul>
<table><thead><tr><th>Change</th><th>Status</th></tr></thead>
<tbody><tr><td>Mention hints</td><td>done</td></tr>
<tr><td>Rich preview</td><td>done</td></tr></tbody></table>
<blockquote><p>Markdown arrives here already sanitized by the host.</p></blockquote>
<pre><code>const answer = 42;</code></pre>`,
      },
    }),
};

const SAMPLE_HTML = `<!doctype html>
<html>
  <body style="font-family: system-ui; padding: 24px;">
    <h1 style="margin-top:0">Coverage report</h1>
    <p>Generated by the agent, previewed in a sandboxed frame.</p>
    <ul><li>statements 94%</li><li>branches 88%</li></ul>
  </body>
</html>
`;

/**
 * An HTML file renders in a `sandbox`-attribute iframe — no scripts, no
 * same-origin — because a previewed file is not ours to trust.
 */
export const HtmlRendered: Story = {
  render: () =>
    buildOpenStory({
      path: '/workspace/coverage.html',
      content: SAMPLE_HTML,
      mimeType: 'text/html',
      rendered: { mount: 'sandbox', html: SAMPLE_HTML },
    }),
};
