import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccUserMessage } from './slicc-user-message.js';
import './slicc-user-message.js';

interface UserMessageArgs {
  text?: string;
}

/**
 * A tiny inline SVG thumbnail as a data URL — stands in for an attached image so
 * the stories stay self-contained (no network / asset dependency).
 */
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

/** Default — a right-aligned dark bubble carrying a short prompt. */
export const Default: Story = {
  args: { text: 'Warm up the landing hero and open a PR.' },
};

/** A longer prompt — the bubble wraps within its 80% max-width cap. */
export const LongPrompt: Story = {
  args: {
    text: 'Our landing hero feels cold and dev-ish. Research it, redesign it warmer, run the tests, and open a PR. Also keep an eye on the support inbox.',
  },
};

/** Short one-liner — the bubble hugs its content, still right-aligned. */
export const ShortPrompt: Story = {
  args: { text: 'ship it' },
};

/** Slotted content (no `text` attribute) — content flows through the default slot. */
export const Slotted: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message');
    el.textContent = 'Slotted message body via the default slot.';
    return el;
  },
};

/**
 * Markdown prompt — inline code, a link, and bold/italic emphasis rendered in
 * the bubble via `setBodyHtml` (the same marked/DOMPurify HTML shape the webapp
 * produces). The markdown chrome is `currentColor`-relative, so it reads on the
 * dark bubble in both themes.
 */
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

/**
 * A richer markdown prompt — a list and a fenced code block, exercising the full
 * bubble markdown chrome.
 */
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

/**
 * A prompt carrying an **image attachment** — the image renders as a thumbnail
 * chip above the bubble, mirroring the webapp's `.attachment-chip`.
 */
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

/**
 * Multiple mixed attachments — two image thumbnails plus a text and a generic
 * file chip (lucide icons), all right-aligned above the bubble.
 */
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

/** An image-only message — no text bubble, just the attachment thumbnail. */
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

/**
 * Click-to-preview — clicking any image thumbnail opens the FLIP-zoom lightbox
 * (`SliccImagePreview`). Click a swatch below to try.
 */
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

/** A realistic two-bubble exchange, reviewing right-alignment and stacking. */
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

/** Queued behind the current turn: dimmed bubble + a small clock tag. */
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

/** With a timestamp — a small HH:mm:ss label above the bubble. */
export const WithTimestamp: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message') as SliccUserMessage;
    el.setAttribute('text', 'Warm up the landing hero and open a PR.');
    el.setAttribute('timestamp', '14:32:07');
    return el;
  },
};
