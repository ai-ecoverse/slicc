import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccUserMessage } from './slicc-user-message.js';
import './slicc-user-message.js';

interface UserMessageArgs {
  text?: string;
}

function swatch(from: string, to: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs><rect width="80" height="80" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const meta: Meta<UserMessageArgs> = {
  title: 'Chat/UserMessage',
  component: 'slicc-user-message',
  tags: ['autodocs'],
  argTypes: {
    text: { control: 'text', description: 'Bubble message text (falls back to slotted content)' },
  },
  render: ({ text }) => {
    const el = document.createElement('slicc-user-message');
    if (text != null) el.setAttribute('text', text);
    return el;
  },
};

export default meta;
type Story = StoryObj<UserMessageArgs>;

export const Default: Story = {
  args: { text: 'Warm up the landing hero and open a PR.' },
};

export const LongPrompt: Story = {
  args: {
    text: 'Our landing hero feels cold and dev-ish. Research it, redesign it warmer, run the tests, and open a PR. Also keep an eye on the support inbox.',
  },
};

export const ShortPrompt: Story = {
  args: { text: 'ship it' },
};

export const Slotted: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message');
    el.textContent = 'Slotted message body via the default slot.';
    return el;
  },
};

export const Markdown: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.setBodyHtml(
      `<p>Run <code>npm run test -w @slicc/webapp</code> and, if it's <strong>green</strong>, ` +
        `open a PR against <a href="https://example.com/main">main</a>.</p>`
    );
    return el;
  },
};

export const RichMarkdown: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.style.display = 'block';
    el.style.maxWidth = '520px';
    el.setBodyHtml(
      `<p>A few asks for the hero pass:</p>
<ul>
<li>Warm the <strong>canvas</strong> token</li>
<li>Collapse the CTAs to <em>one</em></li>
<li>Keep contrast at or above <code>4.5:1</code></li>
</ul>
<p>Use this as the starting token:</p>
<pre><code>--canvas: #faf6f1;</code></pre>`
    );
    return el;
  },
};

export const WithImageAttachment: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.setAttribute('text', 'Match the hero to this palette, please.');
    el.setAttachments([
      {
        name: 'palette.png',
        kind: 'image',
        src: swatch('#ef7000', '#8b5cf6'),
        mime: 'image/png',
        size: 84_213,
      },
    ]);
    return el;
  },
};

export const WithMixedAttachments: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.style.display = 'block';
    el.style.maxWidth = '520px';
    el.setAttribute('text', 'Here are the references and the current tokens — warm it up.');
    el.setAttachments([
      {
        name: 'before.png',
        kind: 'image',
        src: swatch('#0e0e0f', '#1f2937'),
        mime: 'image/png',
        size: 64_120,
      },
      {
        name: 'after.png',
        kind: 'image',
        src: swatch('#faf6f1', '#ef7000'),
        mime: 'image/png',
        size: 71_904,
      },
      { name: 'tokens.css', kind: 'text', mime: 'text/css', size: 2_310 },
      { name: 'brand-guide.pdf', kind: 'file', mime: 'application/pdf', size: 1_280_000 },
    ]);
    return el;
  },
};

export const ImageOnly: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.setAttachments([
      {
        name: 'screenshot.png',
        kind: 'image',
        src: swatch('#06b6d4', '#8b5cf6'),
        mime: 'image/png',
        size: 51_200,
      },
    ]);
    return el;
  },
};

export const ClickToPreview: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.style.display = 'block';
    el.style.maxWidth = '520px';
    el.setAttribute('text', 'Which screenshot looks better?');
    el.setAttachments([
      {
        name: 'option-a.png',
        kind: 'image',
        src: swatch('#fbbf24', '#ef4444'),
        mime: 'image/png',
        size: 128_000,
      },
      {
        name: 'option-b.png',
        kind: 'image',
        src: swatch('#06b6d4', '#7c3aed'),
        mime: 'image/png',
        size: 96_400,
      },
    ]);
    return el;
  },
};

export const Conversation: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:420px;max-width:100%;';
    for (const t of [
      'Can you audit the hero and propose warmer tokens?',
      'Great — go ahead and open the PR when the tests pass.',
    ]) {
      const el = document.createElement('slicc-user-message');
      el.setAttribute('text', t);
      wrap.appendChild(el);
    }
    return wrap;
  },
};

export const Queued: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.style.display = 'block';
    el.style.maxWidth = '520px';
    el.setAttribute('text', 'Also bump the dependency once the tests pass.');
    el.setAttribute('queued', '');
    return el;
  },
};

export const WithTimestamp: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.setAttribute('text', 'Warm up the landing hero and open a PR.');
    el.setAttribute('timestamp', '14:32:07');
    return el;
  },
};

export const LongUnbreakableStrings: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.style.display = 'block';
    el.style.maxWidth = '420px';
    const url =
      'https://example.com/very/long/path/segment/here?query=some-really-long-value&token=0123456789abcdef0123456789abcdef&redirect=https%3A%2F%2Fnested.example.com%2Fdeep%2Fpath';
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const path =
      '/Users/dev/workspace/packages/webcomponents/src/chat/components/really/deeply/nested/directory/slicc-user-message.stories.ts';
    el.setBodyHtml(
      `<p>Pull from <a href="${url}">${url}</a> and check out <code>${hash}</code>.</p>
<p>Then edit <code>${path}</code>:</p>
<pre><code>${path}</code></pre>`
    );
    return el;
  },
};

export const PastedBase64Payload: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.style.display = 'block';
    el.style.maxWidth = '420px';
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk' +
      'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==aGVsbG8gd29ybGQgdGhpcyBpcy' +
      'BhIHBhc3RlZCBwYXlsb2FkIHRoYXQga2VlcHMgb24gZ29pbmc';
    el.setBodyHtml(`<p>here is the screenshot: ${payload}</p>`);
    return el;
  },
};
