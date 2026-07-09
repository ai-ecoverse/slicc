import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-delegation-line.js';

interface DelegArgs {
  kind?: 'feed' | 'scoop' | 'drop' | 'sprinkle';
  hue?: string;
  verb?: string;
  scoop?: string;
  label?: string;
  args?: string;
  source?: boolean;
}

const meta: Meta<DelegArgs> = {
  title: 'Chat/DelegationLine',
  component: 'slicc-delegation-line',
  tags: ['autodocs'],
  argTypes: {
    kind: {
      control: 'inline-radio',
      options: ['feed', 'scoop', 'drop', 'sprinkle'],
      description: 'Delegation kind: feed (delegate) / scoop (spin up) / drop (wrap up) / sprinkle',
    },
    hue: { control: 'color', description: 'Accent hue (sets --c): scoop name + source tint' },
    verb: {
      control: 'text',
      description: 'Verb/connector; raw action names (feed_scoop…) are humanized',
    },
    scoop: { control: 'text', description: 'Bold, hue-colored scoop / sprinkle name' },
    label: { control: 'text', description: 'Trailing prose after the scoop name' },
    args: { control: 'text', description: 'Comma-separated values → inline <code> chips' },
    source: { control: 'boolean', description: 'Active-source highlight (tinted bg/border)' },
  },
  render: ({ kind, hue, verb, scoop, label, args, source }) => {
    const el = document.createElement('slicc-delegation-line');
    if (kind) el.setAttribute('kind', kind);
    if (hue) el.setAttribute('hue', hue);
    if (verb != null) el.setAttribute('verb', verb);
    if (scoop != null) el.setAttribute('scoop', scoop);
    if (label != null) el.setAttribute('label', label);
    if (args != null) el.setAttribute('args', args);
    if (source) el.setAttribute('source', '');
    return el;
  },
};

export default meta;
type Story = StoryObj<DelegArgs>;

/** `→ Delegated to researcher · audit hero.tsx, tokens.css` — the canonical feed line, idle. */
export const FeedScoopIdle: Story = {
  args: {
    kind: 'feed',
    hue: '#06b6d4',
    scoop: 'researcher',
    label: '· audit',
    args: 'hero.tsx, tokens.css',
  },
};

/** The same feed line as the active source (`.src`) — hue-tinted background + border. */
export const FeedScoopSource: Story = {
  args: {
    kind: 'feed',
    hue: '#06b6d4',
    scoop: 'researcher',
    label: '· audit',
    args: 'hero.tsx, tokens.css',
    source: true,
  },
};

/** Designer feed line in violet — `→ feed_scoop designer · warm hero from the findings`. */
export const DesignerFeed: Story = {
  args: {
    kind: 'feed',
    hue: '#8b5cf6',
    scoop: 'designer',
    label: '· warm hero from the findings',
  },
};

/** Tester feed line in amber, highlighted as the source. */
export const TesterSource: Story = {
  args: {
    kind: 'feed',
    hue: '#f59e0b',
    scoop: 'tester',
    label: '· vitest + contrast check',
    source: true,
  },
};

/** `＋ Spun up researcher` — the scoop_scoop action, humanized to "Spun up". */
export const ScoopScoop: Story = {
  args: {
    kind: 'scoop',
    hue: '#06b6d4',
    scoop: 'researcher',
    label: '· to audit the hero',
  },
};

/** `✓ Wrapped up tester` — the drop_scoop action, humanized to "Wrapped up". */
export const DropScoop: Story = {
  args: {
    kind: 'drop',
    hue: '#f59e0b',
    scoop: 'tester',
    label: '· all checks green',
  },
};

/**
 * Passing the raw internal tool name through `verb` still renders the friendly
 * phrase — `feed_scoop` is mapped to `Delegated to`, never shown developer-coded.
 */
export const RawActionNameHumanized: Story = {
  args: {
    kind: 'feed',
    hue: '#8b5cf6',
    verb: 'feed_scoop',
    scoop: 'designer',
    label: '· warm the hero',
  },
};

/** `✦ designer opened Hero studio · interactive sprinkle` — a sprinkle-opened event line. */
export const SprinkleOpened: Story = {
  args: {
    kind: 'sprinkle',
    hue: '#8b5cf6',
    scoop: 'designer',
    label: 'opened Hero studio · interactive sprinkle',
  },
};

/** Sprinkle-opened event highlighted as the active source. */
export const SprinkleOpenedSource: Story = {
  args: {
    kind: 'sprinkle',
    hue: '#8b5cf6',
    scoop: 'designer',
    label: 'opened Hero studio · interactive sprinkle',
    source: true,
  },
};

/** No explicit hue — the scoop name + tint fall back to --violet. */
export const DefaultHue: Story = {
  args: {
    kind: 'feed',
    scoop: 'scoop',
    label: '· no hue set',
    source: true,
  },
};

/** Wrapping behavior — many args force the code chips to flex-wrap onto new lines. */
export const ManyArgsWrap: Story = {
  args: {
    kind: 'feed',
    hue: '#10b981',
    scoop: 'triage',
    label: '· sweep',
    args: 'inbox.ts, labels.ts, rules.ts, digest.ts, queue.ts, sla.ts, archive.ts',
  },
};

/**
 * Long unbreakable strings — a deep file path, a 64-char hex hash, and a long URL
 * as `args` code chips inside a width-constrained (420px) wrapper. Each chip is a
 * single unbreakable token, so the chips overflow the narrow column until the
 * wrapping CSS fix lands.
 */
export const LongUnbreakableStrings: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:420px;';
    const url =
      'https://example.com/very/long/path/segment/here?query=some-really-long-value&token=0123456789abcdef0123456789abcdef';
    const hash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const path =
      '/Users/dev/workspace/packages/webcomponents/src/chat/components/really/deeply/nested/directory/slicc-delegation-line.ts';
    const el = document.createElement('slicc-delegation-line');
    el.setAttribute('kind', 'feed');
    el.setAttribute('hue', '#06b6d4');
    el.setAttribute('scoop', 'researcher');
    el.setAttribute('label', '· inspect');
    el.setAttribute('args', `${path}, ${hash}, ${url}`);
    wrap.appendChild(el);
    return wrap;
  },
};
