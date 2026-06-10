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
import {
  buildThreadChildren,
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
    expect(webhook?.getAttribute('body')).toContain('example/repo');
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
