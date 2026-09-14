import type { Meta, StoryObj } from '@storybook/web-components-vite';

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
import { h } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

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

const promptGlyph = (): SVGSVGElement => iconEl('chevron-right', { size: 12 });

const okGlyph = (): SVGSVGElement => iconEl('check', { size: 12 });

const warnGlyph = (): SVGSVGElement => iconEl('triangle-alert', { size: 12 });

function inline(svg: SVGSVGElement): HTMLElement {
  return h('span', { style: 'display:inline-flex;vertical-align:-2px;' }, svg);
}

function userMsg(text: string): HTMLElement {
  const el = document.createElement('slicc-user-message');
  el.setAttribute('text', text);
  return el;
}

function agentProse(...body: (Node | string)[]): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.append(...body);
  return el;
}

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

function editFileRow(): HTMLElement {
  const row = document.createElement('slicc-action-row');
  row.setAttribute('open', '');
  row.setAttribute('tone', 'vi');
  row.setAttribute('result', '4 changes');
  row.dataset.icon = 'pen';

  const label = h(
    'span',
    null,
    'edit_file · ',
    h('a', { class: 'vlink', 'data-file': 'hero', 'data-kind': 'css' }, 'hero.css')
  );
  row.appendChild(label);

  const body = h(
    'div',
    { slot: 'body' },
    h('span', { class: 'del' }, '- background: #0b1120;'),
    '\n',
    h('span', { class: 'add' }, '+ background: #faf6f1;'),
    '\n',
    h('span', { class: 'del' }, '- color: #e2e8f0;'),
    '\n',
    h('span', { class: 'add' }, '+ color: #7c2d12;'),
    '\n',
    h('span', { class: 'ok' }, inline(okGlyph()), ' live-reloaded at /preview/hero')
  );
  row.appendChild(body);
  return row;
}

function terminalCard(): HTMLElement {
  const el = document.createElement('slicc-action-card');
  el.setAttribute('variant', 'tool');
  el.setAttribute('tone', 'am');
  el.setAttribute('title', 'bash · run suite');
  el.setAttribute('badge', 'warm-hero');
  el.dataset.glyph = 'terminal';
  el.append(
    h('span', { class: 'p' }, inline(promptGlyph())),
    ' npm test -- hero\n',
    h('span', { class: 'ok' }, inline(okGlyph()), ' 128 passed'),
    ' ',
    h('span', { class: 'mut' }, '0 failed · 1.2s'),
    '\n',
    h('span', { class: 'warn' }, inline(warnGlyph()), ' 1 a11y contrast note'),
    ' ',
    h('span', { class: 'mut' }, 'CTA on mobile')
  );
  return el;
}

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
  el.dataset.glyph = 'git-pull-request';
  return el;
}

function lickCard(): HTMLElement {
  const el = document.createElement('slicc-lick-card');
  el.setAttribute('kind', 'webhook');
  el.setAttribute('no-animate', '');
  el.append(
    'A ',
    h('b', null, 'lick'),
    ' arrives — a support webhook pings the session. sliccy queues a triage scoop.'
  );
  return el;
}

function dip(): HTMLElement {
  const el = document.createElement('slicc-dip');
  el.setAttribute('name', 'palette.shtml');
  el.setAttribute('hue', '#ef7000');
  return el;
}

function decorateIcons(root: ParentNode): void {
  for (const row of root.querySelectorAll<HTMLElement>('slicc-action-row[data-icon]')) {
    const chip = row.querySelector('.slicc-act__ic');
    if (chip) chip.replaceChildren(iconEl(row.dataset.icon ?? 'square', { size: 12 }));
  }
  for (const card of root.querySelectorAll<HTMLElement>('slicc-action-card[data-glyph]')) {
    const chip = card.querySelector('.tcard .ic, .prcard .gi');
    if (chip) chip.replaceChildren(iconEl(card.dataset.glyph ?? 'square', { size: 12 }));
  }
}

function populate(el: SliccChatThread): void {
  const sep = document.createElement('slicc-day-separator');
  sep.setAttribute('label', 'Today');
  el.append(sep);

  el.append(userMsg('Redesign the hero — warm canvas, single CTA, keep it accessible.'));

  el.append(
    agentProse(
      h(
        'p',
        null,
        'On it. I’ll warm the canvas, collapse the CTAs to one, and verify contrast. ' +
          'Here’s the plan:'
      )
    )
  );

  const plan = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.append(plan);
  plan.setPlan([
    'Recolor the hero canvas to a warm paper tone',
    'Collapse the two CTAs into one accessible button',
    'Audit contrast and re-run the visual tests',
  ]);

  const check = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.append(check);
  check.setCheck([
    { text: 'Canvas warmed to #faf6f1' },
    { text: 'Single CTA, focus-visible ring restored', variant: 'cy' },
    { text: 'Contrast 4.6:1 — passes AA', variant: 'am' },
  ]);

  el.append(
    feedLine('tester', '#f59e0b', 'audits the redesign for contrast + a11y', 'a11y, contrast')
  );

  el.append(editFileRow());

  el.append(terminalCard());
  el.append(prCard());

  el.append(lickCard());

  el.append(userMsg('Nice. Can I tune the palette live before you open the PR for real?'));
  el.append(
    agentProse(
      h(
        'p',
        null,
        'Absolutely — here’s a ',
        h('b', null, 'dip'),
        '. Pick a canvas and accent, then apply to push it straight into the hero:'
      )
    )
  );

  el.append(dip());

  decorateIcons(el);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => decorateIcons(el));
  }
}

function thread({ open, context, accent }: ThreadArgs): HTMLElement {
  const wrap = document.createElement('div');

  wrap.style.cssText = 'display:flex;flex-direction:column;height:640px;background:var(--bg);';

  const el = document.createElement('slicc-chat-thread') as SliccChatThread;
  if (open) el.setAttribute('open', '');
  if (context) el.setAttribute('context', context);
  if (accent) el.setAttribute('accent', accent);
  wrap.appendChild(el);
  populate(el);
  return wrap;
}

export const MessageHistory: Story = {
  args: { context: 'cone', accent: '#ef7000' },
  render: thread,
};

export const MessageHistoryOpen: Story = {
  args: { context: 'cone', accent: '#ef7000', open: true },
  render: thread,
};

export const MessageHistoryScoop: Story = {
  args: { context: 'researcher', accent: '#06b6d4' },
  render: thread,
};

export const Wide: Story = {
  args: { context: 'cone' },
  render: thread,
};

export const Open: Story = {
  args: { context: 'cone', open: true },
  render: thread,
};

export const FreezerIce: Story = {
  args: { context: 'freezer:abc', accent: '#3b6cb2' },
  render: thread,
};

export const FollowChip: Story = {
  args: { context: 'cone', accent: '#ef7000' },
  render: (args: ThreadArgs) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;height:400px;background:var(--bg);';

    const el = document.createElement('slicc-chat-thread') as SliccChatThread;
    if (args.context) el.setAttribute('context', args.context);
    if (args.accent) el.setAttribute('accent', args.accent);
    wrap.appendChild(el);
    populate(el);

    el.setAttribute('has-new', '');
    requestAnimationFrame(() => {
      el.scrollTop = 0;
    });
    return wrap;
  },
};

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
          el.append(
            agentProse(
              h('p', { style: 'margin:0;' }, 'Switched to the ', h('b', null, id), ' context.')
            )
          );
        }
      });
      bar.appendChild(b);
    }

    wrap.replaceChildren(bar, el);
    return wrap;
  },
};
