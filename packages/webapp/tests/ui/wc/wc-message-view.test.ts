// @vitest-environment jsdom
/**
 * The message-view mapper is exercised against the design-time chat fixture —
 * the single source of truth for every chat UI variant — so every variant the
 * legacy panel renders has a web-component mapping asserted here.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { createChatFixture } from '../../../src/ui/chat-fixture.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import {
  buildThreadChildren,
  collateLickMessages,
  messageEls,
  summarizeToolInput,
} from '../../../src/ui/wc/wc-message-view.js';

const fixture = createChatFixture();

describe('buildThreadChildren', () => {
  let children: HTMLElement[];

  beforeAll(() => {
    children = buildThreadChildren(fixture);
  });

  it('starts with a day separator', () => {
    expect(children[0]?.tagName.toLowerCase()).toBe('slicc-day-separator');
    expect(children[0]?.getAttribute('label')).toBeTruthy();
  });

  it('renders one day separator per local-date boundary', () => {
    const dates = new Set(fixture.map((m) => new Date(m.timestamp).toDateString()));
    const separators = children.filter((c) => c.tagName.toLowerCase() === 'slicc-day-separator');
    expect(separators.length).toBe(dates.size);
  });

  it('renders every fixture lick channel as a lick card', () => {
    const expected = fixture
      .filter((m) => m.source === 'lick')
      .map((m) => m.channel)
      .sort();
    const kinds = children
      .filter((c) => c.tagName.toLowerCase() === 'slicc-lick-card')
      .map((c) => c.getAttribute('kind'))
      .sort();
    expect(kinds).toEqual(expected);
  });

  it('extracts the lick event label from the content header', () => {
    const webhook = children.find(
      (c) => c.tagName.toLowerCase() === 'slicc-lick-card' && c.getAttribute('kind') === 'webhook'
    );
    expect(webhook?.getAttribute('event-label')).toBe('github-push');
    // The body is slotted rich content (markdown-rendered), not the attribute.
    expect(webhook?.textContent).toContain('example/repo');
  });

  it('renders lick cards collapsed by default with markdown bodies, headers stripped', () => {
    const [card] = messageEls({
      id: 'l1',
      role: 'user',
      content: '[Session Reload] Mount recovery required for `/workspace/kb` — **act now**.',
      timestamp: Date.now(),
      source: 'lick',
      channel: 'session-reload',
    });
    expect(card.tagName.toLowerCase()).toBe('slicc-lick-card');
    expect(card.hasAttribute('collapsible')).toBe(true);
    expect(card.hasAttribute('collapsed')).toBe(true);
    // Markdown applied: the **act now** emphasis becomes a real element.
    expect(card.querySelector('strong, b')?.textContent).toBe('act now');
    // The colon-less `[Session Reload]` header marker is stripped from the body.
    expect(card.textContent).not.toContain('[Session Reload]');
    expect(card.textContent).toContain('Mount recovery required');
  });

  it('carries the collation count onto the card, one section per part', () => {
    const [card] = messageEls({
      id: 'l1',
      role: 'user',
      content: '[Session Reload] a\n\n[Session Reload] b',
      timestamp: Date.now(),
      source: 'lick',
      channel: 'session-reload',
      lickCount: 2,
      lickParts: ['[Session Reload] a', '[Session Reload] b'],
    });
    expect(card.getAttribute('count')).toBe('2');
    expect(card.children).toHaveLength(2);
  });

  it('renders plain user messages as user bubbles', () => {
    const userCount = fixture.filter(
      (m) => m.role === 'user' && !m.source && m.channel !== 'delegation'
    ).length;
    const bubbles = children.filter((c) => c.tagName.toLowerCase() === 'slicc-user-message');
    // Delegations contribute one extra user bubble each (instructions body).
    const delegations = fixture.filter(
      (m) => m.source === 'delegation' || m.channel === 'delegation'
    ).length;
    expect(bubbles.length).toBe(userCount + delegations);
  });

  it('renders assistant messages with rendered markdown bodies', () => {
    const agents = children.filter((c) => c.tagName.toLowerCase() === 'slicc-agent-message');
    const assistantCount = fixture.filter((m) => m.role === 'assistant').length;
    expect(agents.length).toBe(assistantCount);
    const withCode = agents.find((a) => a.querySelector('code'));
    expect(withCode).toBeTruthy();
  });

  it('marks the streaming tail message', () => {
    const streaming = fixture.find((m) => m.isStreaming);
    expect(streaming).toBeTruthy();
    const agents = children.filter((c) => c.tagName.toLowerCase() === 'slicc-agent-message');
    expect(agents.some((a) => a.hasAttribute('streaming'))).toBe(true);
  });

  it('renders tool calls as action rows labelled by tool name', () => {
    const toolCallCount = fixture.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
    const rows = children.filter((c) => c.tagName.toLowerCase() === 'slicc-action-row');
    expect(rows.length).toBe(toolCallCount);
    expect(rows.some((r) => r.getAttribute('label')?.startsWith('bash'))).toBe(true);
  });

  it('renders the delegation as a delegation line followed by the instructions', () => {
    const line = children.find((c) => c.tagName.toLowerCase() === 'slicc-delegation-line');
    expect(line).toBeTruthy();
    expect(line?.getAttribute('kind')).toBe('feed');
    const next = children[children.indexOf(line as HTMLElement) + 1];
    expect(next?.tagName.toLowerCase()).toBe('slicc-user-message');
  });

  it('flags queued messages', () => {
    expect(children.some((c) => c.hasAttribute('data-queued'))).toBe(true);
  });
});

describe('messageEls', () => {
  it('maps attachments onto the user bubble', () => {
    const message = fixture.find((m) => m.attachments?.length);
    expect(message).toBeTruthy();
    const [bubble] = messageEls(message as (typeof fixture)[number]);
    expect(bubble.tagName.toLowerCase()).toBe('slicc-user-message');
    // The component renders one chip per attachment into its shadow root.
    expect(bubble.shadowRoot?.querySelectorAll('.attachment-chip').length).toBe(
      message?.attachments?.length ?? -1
    );
  });
});

describe('collateLickMessages', () => {
  function lick(id: string, channel: string, content: string): ChatMessage {
    return { id, role: 'user', content, timestamp: 1, source: 'lick', channel };
  }

  it('merges runs of consecutive same-channel licks into one counted message', () => {
    const out = collateLickMessages([
      lick('a', 'session-reload', '[Session Reload] one'),
      lick('b', 'session-reload', '[Session Reload] two'),
      lick('c', 'session-reload', '[Session Reload] three'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(out[0].lickCount).toBe(3);
    expect(out[0].lickParts).toEqual([
      '[Session Reload] one',
      '[Session Reload] two',
      '[Session Reload] three',
    ]);
  });

  it('keeps different channels and interleaved messages apart', () => {
    const user: ChatMessage = { id: 'u', role: 'user', content: 'hi', timestamp: 1 };
    const out = collateLickMessages([
      lick('a', 'webhook', 'w1'),
      lick('b', 'cron', 'c1'),
      user,
      lick('c', 'cron', 'c2'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'u', 'c']);
    expect(out.every((m) => (m.lickCount ?? 1) === 1)).toBe(true);
  });

  it('does not mutate its input', () => {
    const first = lick('a', 'cron', 'one');
    collateLickMessages([first, lick('b', 'cron', 'two')]);
    expect(first.lickCount).toBeUndefined();
    expect(first.content).toBe('one');
  });
});

describe('summarizeToolInput', () => {
  it('summarizes strings, paths, and commands', () => {
    expect(summarizeToolInput('ls -la\nsecond line')).toBe('ls -la');
    expect(summarizeToolInput({ path: '/workspace/a.ts' })).toBe('/workspace/a.ts');
    expect(summarizeToolInput({ command: 'npm test' })).toBe('npm test');
    expect(summarizeToolInput({ other: 1 })).toBe('');
    expect(summarizeToolInput(null)).toBe('');
  });

  it('truncates long first lines', () => {
    const long = 'x'.repeat(120);
    expect(summarizeToolInput(long)).toHaveLength(80);
    expect(summarizeToolInput(long).endsWith('…')).toBe(true);
  });
});
