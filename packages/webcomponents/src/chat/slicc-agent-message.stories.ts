import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h } from '../internal/dom.js';
import type { CheckItem, SliccAgentMessage } from './slicc-agent-message.js';
import './slicc-agent-message.js';

interface MessageArgs {
  thinking?: boolean;
  streaming?: boolean;
  progress?: string;
}

/** Construct an agent message, applying the boolean state attributes. */
function buildMessage({ thinking, streaming, progress }: MessageArgs): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  if (thinking) el.setAttribute('thinking', '');
  if (streaming) el.setAttribute('streaming', '');
  if (progress) el.setAttribute('progress', progress);
  el.style.maxWidth = '520px';
  return el;
}

/**
 * Build a message hosting already-rendered markdown HTML — the shape the
 * production webapp renderer (packages/webapp/src/ui/message-renderer.ts:
 * marked GFM → DOMPurify) hands to the chat. `setBodyHtml` parses the trusted
 * string via a contextual fragment (no HTML sink).
 */
function markdownMessage(html: string, maxWidth = '520px'): SliccAgentMessage {
  const el = buildMessage({});
  el.style.maxWidth = maxWidth;
  el.setBodyHtml(html);
  return el;
}

const meta: Meta<MessageArgs> = {
  title: 'Chat/AgentMessage',
  component: 'slicc-agent-message',
  tags: ['autodocs'],
  argTypes: {
    thinking: { control: 'boolean', description: 'Show the bouncing-dot thinking row' },
    streaming: { control: 'boolean', description: 'Append the typewriter caret' },
    progress: { control: 'text', description: 'Status label beside the thinking dots' },
  },
  render: (args) => buildMessage(args),
};

export default meta;
type Story = StoryObj<MessageArgs>;

/** Plain prose body — rendered-markdown HTML slotted into the `.body`. */
export const Prose: Story = {
  render: () => {
    const el = buildMessage({});
    // Pre-existing light children are relocated into `.body` on connect; build
    // them via DOM construction rather than an HTML string.
    el.append(
      h(
        'p',
        null,
        'Sure — I dug through the ',
        h('code', null, 'warm-hero'),
        ' branch and the redesign is mostly there. A few ',
        h('strong', null, 'follow-ups'),
        ' remain before it ships, but nothing structural.'
      )
    );
    return el;
  },
};

/** Heading hierarchy (h1–h4) interleaved with prose — GFM heading rendering. */
export const Headings: Story = {
  render: () =>
    markdownMessage(
      `<h1>Hero redesign — findings</h1>
<p>Here's the full audit, with <strong>recommendations</strong> and the <em>rationale</em> behind each one.</p>
<h2>Summary</h2>
<p>The current hero leads with a near-black canvas and a monospaced headline, which signals "developer tool" more than "product".</p>
<h3>Proposed changes</h3>
<p>A warm paper canvas, one large display headline, and a single high-contrast CTA.</p>
<h4>Risk</h4>
<p>Low — the change is token-scoped and fully reversible.</p>`
    ),
};

/** Ordered + nested unordered lists and inline emphasis — GFM list rendering. */
export const Lists: Story = {
  render: () =>
    markdownMessage(
      `<p>Plan of attack:</p>
<ol>
<li>Audit the current hero
<ul>
<li>Measure contrast ratios</li>
<li>Check headline weight and size</li>
</ul>
</li>
<li>Redesign warmer in a live <strong>Hero studio</strong> sprinkle</li>
<li>Verify in the browser, run the tests, then open a PR</li>
</ol>
<p>Acceptance criteria:</p>
<ul>
<li><strong>Canvas</strong> swapped to warm paper</li>
<li>A single pill <code>CTA</code></li>
<li>Body contrast at or above <em>4.5 : 1</em></li>
</ul>`
    ),
};

/** Inline code plus a fenced code block — mirrors the marked <pre><code> shape. */
export const CodeBlock: Story = {
  render: () =>
    markdownMessage(
      `<p>Swap the canvas token and add the display headline rule in <code>hero.css</code>:</p>
<pre><code class="language-css">.hero {
  background: #faf6f1;
}
.hero h1 {
  font-family: Fraunces, serif;
  font-size: 64px;
}</code></pre>
<p>Then re-run <code>npm run test -w @slicc/webapp</code> to confirm the visual suite stays green.</p>`
    ),
};

/** Blockquote with inline link, bold, and italic — GFM blockquote rendering. */
export const Blockquote: Story = {
  render: () =>
    markdownMessage(
      `<blockquote>
<p>Lead with <strong>warmth</strong>, not <em>chrome</em>. One headline, one CTA, and let the product breathe.</p>
</blockquote>
<p>Pulled from the <a href="https://example.com/brand" target="_blank" rel="noopener noreferrer">brand voice</a> skill, now available to every scoop.</p>`
    ),
};

/** GFM table — header row plus body cells, inline code in cells. */
export const Table: Story = {
  render: () =>
    markdownMessage(
      `<table>
<thead><tr><th>Element</th><th>Current</th><th>Proposed</th></tr></thead>
<tbody>
<tr><td>Canvas</td><td><code>#0e0e0f</code></td><td><code>#faf6f1</code></td></tr>
<tr><td>Headline</td><td>mono · 28px</td><td>Fraunces · 64px</td></tr>
<tr><td>Primary actions</td><td>6 buttons</td><td>1 pill CTA</td></tr>
<tr><td>Body contrast</td><td>3.1 : 1</td><td>5.2 : 1</td></tr>
</tbody>
</table>`,
      '640px'
    ),
};

/** Mixed long-form prose exercising the full GFM feature set in one message. */
export const RichMarkdown: Story = {
  render: () =>
    markdownMessage(
      `<h2>Warm hero — final report</h2>
<p>Shipped the redesign end-to-end. The hero now leads with a <strong>warm paper canvas</strong> and a single <em>display</em> headline; the old <del>six-button</del> action row is one pill CTA.</p>
<h3>What changed</h3>
<ol>
<li>Audited the cold hero (researcher scoop)</li>
<li>Redesigned in a live sprinkle, then verified in the browser
<ul>
<li>Contrast lifted from 3.1 : 1 to 5.2 : 1</li>
<li>Headline swapped to <code>Fraunces, serif</code></li>
</ul>
</li>
<li>Opened <a href="https://example.com/pr/128" target="_blank" rel="noopener noreferrer">PR #128</a></li>
</ol>
<blockquote>
<p>One headline, one CTA — let the product breathe.</p>
</blockquote>
<h3>Token diff</h3>
<table>
<thead><tr><th>Token</th><th>Before</th><th>After</th></tr></thead>
<tbody>
<tr><td>Canvas</td><td><code>#0e0e0f</code></td><td><code>#faf6f1</code></td></tr>
<tr><td>Headline</td><td>mono · 28px</td><td>Fraunces · 64px</td></tr>
</tbody>
</table>
<p>The core rule, for reference:</p>
<pre><code class="language-css">.hero {
  background: #faf6f1;
}</code></pre>
<hr>
<p>Next up: roll the same paper canvas across the pricing page. Reply <strong>go</strong> and I'll spin up a scoop.</p>`,
      '640px'
    ),
};

/** A colored-dot `.plan` list — the first three bullets cycle rose / violet / cyan. */
export const Plan: Story = {
  render: () => {
    const el = buildMessage({});
    el.setPlan([
      'Warm the hero palette and swap the cold blue gradient',
      'Tighten the headline spacing on small viewports',
      'Re-run the visual regression suite',
      'Open a PR against main',
    ]);
    return el;
  },
};

/** A rounded check-badge `.check` list — default green badges. */
export const Check: Story = {
  render: () => {
    const el = buildMessage({});
    const items: CheckItem[] = [
      { text: 'Palette warmed and gradient replaced' },
      { text: 'Headline spacing fixed on mobile' },
      { text: 'Visual regression suite passing' },
    ];
    el.setCheck(items);
    return el;
  },
};

/** Check list exercising every badge accent: default, rose, cyan, violet, amber. */
export const CheckVariants: Story = {
  render: () => {
    const el = buildMessage({});
    const items: CheckItem[] = [
      { text: 'Default green check', variant: '' },
      { text: 'Rose badge', variant: 'r' },
      { text: 'Cyan badge', variant: 'cy' },
      { text: 'Violet badge', variant: 'vi' },
      { text: 'Amber badge', variant: 'am' },
    ];
    el.setCheck(items);
    return el;
  },
};

/** Thinking state — the three bouncing rose/cyan/violet dots, body hidden. */
export const Thinking: Story = {
  render: () => {
    const el = buildMessage({ thinking: true, progress: 'Thinking…' });
    el.setBodyHtml('<p>The typed plan will land here once the cone finishes thinking.</p>');
    return el;
  },
};

/**
 * Progress message — the busy/thinking row carries a status label beside the
 * bouncing dots, set via the `progress` attribute. Used to surface what the
 * agent is doing while the body is still empty.
 */
export const Progress: Story = {
  render: () => buildMessage({ thinking: true, progress: 'Running tools — edit_file · bash' }),
};

/** Streaming — prose with the blinking typewriter caret trailing the body. */
export const Streaming: Story = {
  render: () => {
    const el = buildMessage({ streaming: true });
    el.setBodyHtml('<p>Warming the hero palette and replacing the cold blue gradient');
    return el;
  },
};

/**
 * The full chat-state matrix in one view — the busy row's `progress` label
 * distinguishes the otherwise-identical bouncing dots across **thinking**,
 * **running tools**, and **waiting for user input**, plus the **streaming**
 * typewriter caret. Mirrors how the production chat surfaces agent state.
 */
export const States: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '22px';
    wrap.style.maxWidth = '520px';

    wrap.append(
      buildMessage({ thinking: true, progress: 'Thinking…' }),
      buildMessage({ thinking: true, progress: 'Running tools — edit_file · bash' }),
      buildMessage({ thinking: true, progress: 'Waiting for your reply…' })
    );

    const streaming = buildMessage({ streaming: true });
    streaming.setBodyHtml('<p>Warming the hero palette and replacing the cold blue gradient');
    wrap.append(streaming);

    return wrap;
  },
};

/** With a timestamp — a small HH:mm:ss label above the body. */
export const WithTimestamp: Story = {
  render: () => {
    const el = buildMessage({});
    el.setAttribute('timestamp', '14:32:15');
    el.setBodyHtml(
      '<p>Done — the hero is warmed up and the PR is open. Let me know if you want any tweaks.</p>'
    );
    return el;
  },
};
