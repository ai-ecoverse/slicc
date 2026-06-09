import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Import every composed child module so its custom element registers when the
// thread renders a populated conversation. A `<slicc-chat-thread>` is just a
// scroll column that composes message / card / dip children by tag, so the
// "message history" stories are only as rich as the children they slot.
import '../primitives/slicc-day-separator.js';
import './slicc-action-card.js';
import './slicc-action-row.js';
import './slicc-agent-message.js';
import type { SliccAgentMessage } from './slicc-agent-message.js';
import './slicc-chat-thread.js';
import type { SliccChatThread } from './slicc-chat-thread.js';
import './slicc-delegation-line.js';
import './slicc-dip.js';
import './slicc-lick-card.js';
import './slicc-user-message.js';
import { iconSvg } from '../internal/icons.js';

interface ThreadArgs {
  open?: boolean;
  context?: string;
  accent?: string;
}

const meta: Meta<ThreadArgs> = {
  title: 'Chat/ChatThread',
  component: 'slicc-chat-thread',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Narrow-chat variant (tighter padding + feather)' },
    context: { control: 'text', description: 'Active context id' },
    accent: { control: 'color', description: 'Force the local --ctx shader tint' },
  },
};

export default meta;
type Story = StoryObj<ThreadArgs>;

// ---------------------------------------------------------------------------
// Glyphs — every icon rendered by these stories comes from lucide via the
// shared `iconSvg` helper (never an emoji or bespoke unicode symbol). The
// terminal-prompt arrow and the inline success/warning marks live inside the
// monospace bodies, where they inherit the body's `currentColor`.
// ---------------------------------------------------------------------------

/** A monospace prompt arrow (lucide `chevron-right`) for terminal/diff bodies. */
const PROMPT = iconSvg('chevron-right', { size: 12 });
/** An inline success mark (lucide `check`) for `.ok` spans. */
const OK = iconSvg('check', { size: 12 });
/** An inline warning mark (lucide `triangle-alert`) for `.warn` spans. */
const WARN = iconSvg('triangle-alert', { size: 12 });

/** Wrap an inline lucide glyph so it baseline-aligns inside monospace text. */
function inline(svg: string): string {
  return `<span style="display:inline-flex;vertical-align:-2px;">${svg}</span>`;
}

// ---------------------------------------------------------------------------
// Child builders — small factories so each composed message/card is a real,
// connected element in the thread (the whole point of the "message history"
// stories: multiple distinct child elements rendered in DOM order).
// ---------------------------------------------------------------------------

/** A right-aligned user bubble (`<slicc-user-message>`). */
function userMsg(text: string): HTMLElement {
  const el = document.createElement('slicc-user-message');
  el.setAttribute('text', text);
  return el;
}

/** An agent prose message (`<slicc-agent-message>`) with trusted body HTML. */
function agentProse(html: string): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.innerHTML = html;
  return el;
}

/** A feed delegation line (`<slicc-delegation-line kind="feed">`). */
function feedLine(scoop: string, hue: string, label: string, args: string): HTMLElement {
  const el = document.createElement('slicc-delegation-line');
  el.setAttribute('kind', 'feed');
  el.setAttribute('hue', hue);
  el.setAttribute('scoop', scoop);
  el.setAttribute('label', label);
  el.setAttribute('args', args);
  el.setAttribute('source', '');
  return el;
}

/**
 * An expandable `edit_file` diff row (`<slicc-action-row>`). The square chip is
 * a lucide icon injected into the light-DOM `::part(icon)` after connect (the
 * `icon` attribute is plain-text only, so we never set a unicode glyph there).
 */
function editFileRow(): HTMLElement {
  const row = document.createElement('slicc-action-row');
  row.setAttribute('open', '');
  row.setAttribute('tone', 'vi');
  row.setAttribute('result', '4 changes');
  row.dataset.icon = 'pen'; // injected post-connect (see decorateIcons)

  const label = document.createElement('span');
  label.innerHTML = 'edit_file · <a class="vlink" data-file="hero" data-kind="css">hero.css</a>';
  row.appendChild(label);

  const body = document.createElement('div');
  body.setAttribute('slot', 'body');
  body.innerHTML =
    '<span class="del">- background: #0b1120;</span>\n' +
    '<span class="add">+ background: #faf6f1;</span>\n' +
    '<span class="del">- color: #e2e8f0;</span>\n' +
    '<span class="add">+ color: #7c2d12;</span>\n' +
    `<span class="ok">${inline(OK)} live-reloaded at /preview/hero</span>`;
  row.appendChild(body);
  return row;
}

/** A tool/terminal action card (`<slicc-action-card variant="tool">`). */
function terminalCard(): HTMLElement {
  const el = document.createElement('slicc-action-card');
  el.setAttribute('variant', 'tool');
  el.setAttribute('tone', 'am');
  el.setAttribute('title', 'bash · run suite');
  el.setAttribute('badge', 'warm-hero');
  el.dataset.glyph = 'terminal'; // injected post-connect (see decorateIcons)
  el.innerHTML =
    `<span class="p">${inline(PROMPT)}</span> npm test -- hero\n` +
    `<span class="ok">${inline(OK)} 128 passed</span> <span class="mut">0 failed · 1.2s</span>\n` +
    `<span class="warn">${inline(WARN)} 1 a11y contrast note</span> <span class="mut">CTA on mobile</span>`;
  return el;
}

/** A pull-request action card (`<slicc-action-card variant="pr">`). */
function prCard(): HTMLElement {
  const el = document.createElement('slicc-action-card');
  el.setAttribute('variant', 'pr');
  el.setAttribute('title', 'feat(hero): warm redesign');
  el.setAttribute('number', '#128');
  el.setAttribute('status', 'Open');
  el.setAttribute('branch', 'warm-hero → main');
  el.setAttribute('files', '2');
  el.setAttribute('add', '38');
  el.setAttribute('del', '21');
  el.setAttribute('checks', 'passing');
  el.dataset.glyph = 'git-pull-request'; // injected into .gi post-connect
  return el;
}

/** A lick notification card (`<slicc-lick-card>`). */
function lickCard(): HTMLElement {
  const el = document.createElement('slicc-lick-card');
  el.setAttribute('kind', 'webhook');
  el.setAttribute('no-animate', '');
  el.innerHTML =
    'A <b>lick</b> arrives — a support webhook pings the session. sliccy queues a triage scoop.';
  return el;
}

/** An in-chat sprinkle dip (`<slicc-dip>`). */
function dip(): HTMLElement {
  const el = document.createElement('slicc-dip');
  el.setAttribute('name', 'palette.shtml');
  el.setAttribute('hue', '#ef7000');
  return el;
}

/**
 * After the children connect, inject lucide `<svg>`s into the light-DOM icon
 * chips that only accept plain-text via their attributes (`slicc-action-row`'s
 * `.slicc-act__ic`, `slicc-action-card`'s `.tcard .ic` / `.prcard .gi`). The
 * components own those chips, but their light DOM is queryable here, so the
 * stories stay emoji-free without touching the component source.
 */
function decorateIcons(root: ParentNode): void {
  for (const row of root.querySelectorAll<HTMLElement>('slicc-action-row[data-icon]')) {
    const chip = row.querySelector('.slicc-act__ic');
    if (chip) chip.innerHTML = iconSvg(row.dataset.icon ?? 'square', { size: 12 });
  }
  for (const card of root.querySelectorAll<HTMLElement>('slicc-action-card[data-glyph]')) {
    const chip = card.querySelector('.tcard .ic, .prcard .gi');
    if (chip) chip.innerHTML = iconSvg(card.dataset.glyph ?? 'square', { size: 12 });
  }
}

/**
 * Populate a thread with a realistic multi-turn conversation, in DOM order:
 * day separator → user → agent (prose) → agent (plan) → agent (check) →
 * feed delegation → edit_file diff row → terminal card → PR card → lick →
 * user → agent → dip.
 */
function populate(el: SliccChatThread): void {
  const sep = document.createElement('slicc-day-separator');
  sep.setAttribute('label', 'Today');
  el.append(sep);

  el.append(userMsg('Redesign the hero — warm canvas, single CTA, keep it accessible.'));

  el.append(
    agentProse(
      '<p>On it. I&rsquo;ll warm the canvas, collapse the CTAs to one, and verify contrast. ' +
        'Here&rsquo;s the plan:</p>'
    )
  );

  // Agent message carrying a colored-dot plan list (rose / violet / cyan).
  const plan = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.append(plan);
  plan.setPlan([
    'Recolor the hero canvas to a warm paper tone',
    'Collapse the two CTAs into one accessible button',
    'Audit contrast and re-run the visual tests',
  ]);

  // Agent message carrying a check-badge list (green / cyan / amber).
  const check = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.append(check);
  check.setCheck([
    { text: 'Canvas warmed to #faf6f1' },
    { text: 'Single CTA, focus-visible ring restored', variant: 'cy' },
    { text: 'Contrast 4.6:1 — passes AA', variant: 'am' },
  ]);

  // A feed delegation: hand the contrast audit to the tester scoop.
  el.append(
    feedLine('tester', '#f59e0b', 'audits the redesign for contrast + a11y', 'a11y, contrast')
  );

  // An expandable edit_file diff row.
  el.append(editFileRow());

  // The tool run and the resulting PR, as two distinct cards.
  el.append(terminalCard());
  el.append(prCard());

  // An inbound lick (external webhook event).
  el.append(lickCard());

  // A second user turn and the agent's reply.
  el.append(userMsg('Nice. Can I tune the palette live before you open the PR for real?'));
  el.append(
    agentProse(
      '<p>Absolutely — here&rsquo;s a <b>dip</b>. Pick a canvas and accent, then apply ' +
        'to push it straight into the hero:</p>'
    )
  );

  // A live, interactive sprinkle dip.
  el.append(dip());

  // The action-row / action-card icon wells are built in the children's
  // `connectedCallback`, which only fires once Storybook mounts the returned
  // tree. Decorate on the next frame so the lucide chips land after connect.
  // (Run it inline too, harmlessly, in case the thread is already connected.)
  decorateIcons(el);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => decorateIcons(el));
  }
}

/** Build a populated thread element for a story. */
function thread({ open, context, accent }: ThreadArgs): HTMLElement {
  const wrap = document.createElement('div');
  // The thread is a flex child of a column pane in the app; give it a height
  // so the scroll + centered column read correctly in isolation.
  wrap.style.cssText = 'display:flex;flex-direction:column;height:640px;background:var(--bg);';

  const el = document.createElement('slicc-chat-thread') as SliccChatThread;
  if (open) el.setAttribute('open', '');
  if (context) el.setAttribute('context', context);
  if (accent) el.setAttribute('accent', accent);
  wrap.appendChild(el);
  populate(el);
  return wrap;
}

/**
 * **Message history** — the headline story: a full, realistic multi-turn
 * conversation rendered in DOM order, composing every chat child by tag
 * (day separator, user/agent messages with plan + check lists, a feed
 * delegation line, an expandable `edit_file` diff row, a terminal card, a PR
 * card, a lick card, and an interactive dip). Every icon is a lucide `<svg>`.
 */
export const MessageHistory: Story = {
  args: { context: 'cone', accent: '#ef7000' },
  render: thread,
};

/** The same history in the narrow-chat (`open`) variant: tighter padding + feather. */
export const MessageHistoryOpen: Story = {
  args: { context: 'cone', accent: '#ef7000', open: true },
  render: thread,
};

/** Researcher scoop context — the cyan shader tint via a forced accent. */
export const MessageHistoryScoop: Story = {
  args: { context: 'researcher', accent: '#06b6d4' },
  render: thread,
};

/** Default (wide): 56/72px padding with a 72/56px edge feather, cone amber shader. */
export const Wide: Story = {
  args: { context: 'cone' },
  render: thread,
};

/** Narrow chat (`open`): tighter 24/32px padding + feather for the 34% chat pane. */
export const Open: Story = {
  args: { context: 'cone', open: true },
  render: thread,
};

/** Frozen session context — the freezer ice-blue shader tint. */
export const FreezerIce: Story = {
  args: { context: 'freezer:abc', accent: '#3b6cb2' },
  render: thread,
};

/** Live context swap: a button drives `switchContext`, snapshotting + retinting. */
export const ContextSwap: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;height:640px;background:var(--bg);';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;padding:10px;flex:0 0 auto;';

    const el = document.createElement('slicc-chat-thread') as SliccChatThread;
    el.setAttribute('context', 'cone');
    el.setAttribute('accent', '#ef7000');
    wrap.appendChild(el);
    populate(el);

    const contexts: [string, string][] = [
      ['cone', '#ef7000'],
      ['researcher', '#06b6d4'],
      ['designer', '#8b5cf6'],
    ];
    for (const [id, color] of contexts) {
      const b = document.createElement('button');
      b.textContent = id;
      b.style.cssText =
        'font:500 12px var(--ui);padding:5px 11px;border:1px solid var(--line);border-radius:9999px;background:var(--canvas);color:var(--ink);cursor:pointer;';
      b.addEventListener('click', () => {
        el.setAttribute('accent', color);
        el.switchContext(id);
        if (!el.inner.children.length) {
          const sep = document.createElement('slicc-day-separator');
          sep.setAttribute('label', `${id} scoop`);
          el.append(sep);
          el.append(agentProse(`<p style="margin:0;">Switched to the <b>${id}</b> context.</p>`));
        }
      });
      bar.appendChild(b);
    }

    wrap.replaceChildren(bar, el);
    return wrap;
  },
};
