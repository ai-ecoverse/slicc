import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../primitives/slicc-day-separator.js';
import './slicc-chat-thread.js';
import type { SliccChatThread } from './slicc-chat-thread.js';

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

/** A bot message bubble, matching the prototype `.msg.bot .body`. */
function botMsg(html: string): string {
  return `<div class="msg bot" style="margin-bottom:18px;font-size:15px;line-height:1.5;"><div class="body">${html}</div></div>`;
}

/** A right-aligned user message bubble (`.msg.user .b`). */
function userMsg(text: string): string {
  return (
    '<div class="msg user" style="margin-bottom:18px;display:flex;justify-content:flex-end;">' +
    '<div class="b" style="background:var(--deep);color:#fff;padding:10px 14px;border-radius:16px 16px 4px 16px;font-size:14px;max-width:80%;">' +
    `${text}</div></div>`
  );
}

/** Populate a thread with a realistic, reviewable conversation. */
function populate(el: SliccChatThread): void {
  const sep = document.createElement('slicc-day-separator');
  sep.setAttribute('label', 'Today');
  el.append(sep);

  const frag = document.createElement('div');
  frag.style.display = 'contents';
  frag.innerHTML =
    userMsg('Ship the new chat thread component.') +
    botMsg(
      '<p style="margin:0 0 10px;">On it — lifting <b>.thread</b> / <b>.inner</b> into a vanilla web component with the frosted per-context shader and two-axis edge feather.</p>'
    ) +
    botMsg(
      '<p style="margin:0;">The centered column maxes out at <b>776px</b> and the fade lives entirely in the padding gutter, so text never touches the feather.</p>'
    ) +
    userMsg('Make it work in the narrow chat too.') +
    botMsg(
      '<p style="margin:0;">Done. The <code>open</code> attribute mirrors <code>.shell.open .inner</code> — tighter padding (24/32px) with a matching feather.</p>'
    );
  for (const node of Array.from(frag.childNodes)) el.append(node);
}

/** Build a populated thread element for a story. */
function thread({ open, context, accent }: ThreadArgs): HTMLElement {
  const wrap = document.createElement('div');
  // The thread is a flex child of a column pane in the app; give it a height
  // so the scroll + centered column read correctly in isolation.
  wrap.style.cssText = 'display:flex;flex-direction:column;height:560px;background:var(--bg);';

  const el = document.createElement('slicc-chat-thread') as SliccChatThread;
  if (open) el.setAttribute('open', '');
  if (context) el.setAttribute('context', context);
  if (accent) el.setAttribute('accent', accent);
  wrap.appendChild(el);
  populate(el);
  return wrap;
}

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

/** Researcher scoop context — the cyan shader tint via a forced accent. */
export const ScoopCyan: Story = {
  args: { context: 'researcher', accent: '#06b6d4' },
  render: thread,
};

/** Designer scoop context — the violet shader tint. */
export const ScoopViolet: Story = {
  args: { context: 'designer', accent: '#8b5cf6' },
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
    wrap.style.cssText = 'display:flex;flex-direction:column;height:560px;background:var(--bg);';

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;padding:10px;flex:0 0 auto;';

    const el = document.createElement('slicc-chat-thread') as SliccChatThread;
    el.setAttribute('context', 'cone');
    el.setAttribute('accent', '#f59e0b');
    populate(el);

    const contexts: [string, string][] = [
      ['cone', '#f59e0b'],
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
          el.append(botMsgEl(`<p style="margin:0;">Switched to the <b>${id}</b> context.</p>`));
        }
      });
      bar.appendChild(b);
    }

    wrap.append(bar, el);
    return wrap;
  },
};

/** A bot message as a constructed element (for the swap story's fresh contexts). */
function botMsgEl(html: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'msg bot';
  d.style.cssText = 'margin-bottom:18px;font-size:15px;line-height:1.5;';
  d.innerHTML = `<div class="body">${html}</div>`;
  return d;
}
