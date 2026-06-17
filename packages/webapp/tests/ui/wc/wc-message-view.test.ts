// @vitest-environment jsdom
/**
 * The message-view mapper is exercised against the design-time chat fixture —
 * the single source of truth for every chat UI variant — so every variant the
 * legacy panel renders has a web-component mapping asserted here.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

// Deterministic cluster labels: the real quick-llm needs a provider key.
vi.mock('../../../src/ui/quick-llm.js', () => ({
  quickLabel: vi.fn(async () => 'Push the release to main'),
}));

import { hasIcon } from '@slicc/webcomponents';
import { createChatFixture } from '../../../src/ui/chat-fixture.js';
import type { ChatMessage } from '../../../src/ui/types.js';
import {
  BASH_ICONS,
  buildThreadChildren,
  collateLickMessages,
  isInvalidModelError,
  isNoApiKeyError,
  messageEls,
  NO_API_KEY_ERROR_PREFIX,
  summarizeToolInput,
  TOOL_ICONS,
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

  it('maps an actionable lick lickState onto the card state attribute', () => {
    const base = {
      id: 'sudo-request-lick-1',
      role: 'user' as const,
      content: '[@alpha-scoop sudo-request]\nKind: command\nDetail: git push',
      timestamp: Date.now(),
      source: 'lick',
      channel: 'sudo-request',
      lickId: 'lick-1',
    };
    // Pending / unset leaves the card stateless (default amber, no glyph).
    const [pending] = messageEls({ ...base, lickState: 'pending' });
    expect(pending.hasAttribute('state')).toBe(false);
    const [unset] = messageEls(base);
    expect(unset.hasAttribute('state')).toBe(false);
    // A settled lick stamps confirmed / dismissed onto the card.
    const [confirmed] = messageEls({ ...base, lickState: 'confirmed' });
    expect(confirmed.getAttribute('state')).toBe('confirmed');
    const [dismissed] = messageEls({ ...base, lickState: 'dismissed' });
    expect(dismissed.getAttribute('state')).toBe('dismissed');
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

  it('renders every tool call as an action row (3+ runs collapse into clusters)', () => {
    const toolCallCount = fixture.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
    const host = document.createElement('div');
    host.append(...buildThreadChildren(fixture));
    // Rows inside clusters count too — querySelectorAll pierces the wrapper.
    const rows = host.querySelectorAll('slicc-action-row');
    expect(rows.length).toBe(toolCallCount);
    // Titles are human phrases, never function-call names.
    const labels = [...rows].map((r) => r.getAttribute('label') ?? '');
    expect(labels.some((l) => l === "Use Sliccy's computer")).toBe(true);
    expect(labels.every((l) => !/^(bash|read_file|write_file|edit_file)\b/.test(l))).toBe(true);
    // Any message with 3+ calls renders them behind a slicc-tool-cluster.
    const clustered = fixture.filter((m) => (m.toolCalls?.length ?? 0) >= 3);
    expect(host.querySelectorAll('slicc-tool-cluster').length).toBe(clustered.length);
  });

  it('renders the delegation as a delegation line followed by the instructions', () => {
    const line = children.find((c) => c.tagName.toLowerCase() === 'slicc-delegation-line');
    expect(line).toBeTruthy();
    expect(line?.getAttribute('kind')).toBe('feed');
    const next = children[children.indexOf(line as HTMLElement) + 1];
    expect(next?.tagName.toLowerCase()).toBe('slicc-user-message');
  });

  it('flags queued messages', () => {
    expect(children.some((c) => c.hasAttribute('queued'))).toBe(true);
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

  it('renders a plain error message as a retry-action error card', () => {
    const [card] = messageEls({
      id: 'e1',
      role: 'assistant',
      content: 'rate limited',
      timestamp: 1,
      error: true,
    });
    expect(card.tagName.toLowerCase()).toBe('slicc-error-card');
    // No `action` attribute → defaults to the existing 'retry' CTA.
    expect(card.getAttribute('action')).toBeNull();
    expect(card.getAttribute('message-id')).toBe('e1');
  });

  it('flips to action="change-model" when the body carries the invalid-model marker', () => {
    // The Bedrock CAMP wrapper (`providers/built-in/bedrock-camp.ts`) prefixes
    // the upstream "The provided model identifier is invalid" with its own
    // validation envelope. Detection MUST survive both shapes.
    const [card] = messageEls({
      id: 'e-im',
      role: 'assistant',
      content:
        'Validation error: Bedrock CAMP API error (400): The provided model identifier is invalid.',
      timestamp: 1,
      error: true,
    });
    expect(card.tagName.toLowerCase()).toBe('slicc-error-card');
    expect(card.getAttribute('action')).toBe('change-model');
  });
});

describe('isInvalidModelError', () => {
  it('matches the Bedrock CAMP wrapped form (case-insensitive)', () => {
    expect(
      isInvalidModelError(
        'Validation error: Bedrock CAMP API error (400): The provided model identifier is invalid.'
      )
    ).toBe(true);
    expect(isInvalidModelError('the PROVIDED Model Identifier is INVALID — switch models')).toBe(
      true
    );
  });

  it('matches the bare upstream substring on other providers', () => {
    expect(isInvalidModelError('AccessDenied: The provided model identifier is invalid')).toBe(
      true
    );
  });

  it('rejects unrelated errors, empty strings, and nullish input', () => {
    expect(isInvalidModelError('rate limited')).toBe(false);
    expect(isInvalidModelError('invalid api key')).toBe(false);
    expect(isInvalidModelError('')).toBe(false);
    expect(isInvalidModelError(null)).toBe(false);
    expect(isInvalidModelError(undefined)).toBe(false);
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

  it('never collates actionable licks — each keeps its own row + persisted lickState', () => {
    function actionable(
      id: string,
      lickId: string,
      lickState: ChatMessage['lickState']
    ): ChatMessage {
      return {
        id,
        role: 'user',
        content: '[Scoop Access Request: alpha]',
        timestamp: 1,
        source: 'lick',
        channel: 'sudo-request',
        lickId,
        lickState,
      };
    }
    const out = collateLickMessages([
      actionable('a', 'lick-a', 'confirmed'),
      actionable('b', 'lick-b', 'pending'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out.every((m) => (m.lickCount ?? 1) === 1)).toBe(true);
    expect(out[0].lickId).toBe('lick-a');
    expect(out[0].lickState).toBe('confirmed');
    expect(out[1].lickId).toBe('lick-b');
    expect(out[1].lickState).toBe('pending');
  });
});

describe('tool presentation', () => {
  function call(name: string, input: unknown, result?: string): ChatMessage {
    return {
      id: `m-${name}`,
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      toolCalls: [{ id: 't1', name, input, result }],
    };
  }

  it('titles tools as human phrases with fitting lucide icons', () => {
    const cases: Array<[string, unknown, string, string]> = [
      ['bash', { command: 'git push origin main' }, "Use Sliccy's computer", 'git-branch'],
      ['bash', { command: 'FOO=1 sudo npm install' }, "Use Sliccy's computer", 'package'],
      ['bash', { command: 'frobnicate --wat' }, "Use Sliccy's computer", 'terminal'],
      ['read_file', { path: '/workspace/CLAUDE.md' }, 'Read CLAUDE.md', 'file-text'],
      ['write_file', { path: '/tmp/a.ts', content: 'x' }, 'Write a.ts', 'file-plus'],
      ['edit_file', { path: '/tmp/a.ts' }, 'Edit a.ts', 'file-pen'],
      ['send_message', { message: 'hi' }, 'Send a message to Sliccy', 'message-circle'],
      ['feed_scoop', { name: 'pomodoro' }, 'Feed the pomodoro scoop', 'utensils'],
      ['lick_confirm', { lick_id: 'lick-1' }, 'Grant the scoop access', 'shield-check'],
      ['lick_dismiss', { lick_id: 'lick-1' }, 'Hold the scoop back', 'shield-x'],
      [
        'sudo_request',
        { kind: 'command', detail: 'git push' },
        'Ask for command access',
        'shield-question',
      ],
      ['sudo_request', {}, 'Ask for more access', 'shield-question'],
      ['list_sudo_requests', {}, 'Check access requests', 'list-checks'],
      ['web_search', { query: 'x' }, 'Web search', 'wrench'],
    ];
    for (const [name, input, title, icon] of cases) {
      const [, row] = messageEls(call(name, input, 'ok'));
      expect(row.getAttribute('label'), name).toBe(title);
      expect(row.getAttribute('icon'), name).toBe(icon);
    }
  });

  // Regression guard: every name in `BASH_ICONS` and `TOOL_ICONS` must resolve
  // against the real lucide registry, plus the generic fallbacks `toolIcon`
  // returns on miss. Without this guard, a bad entry (historically
  // `gh: 'github'` — lucide ships `Github` is gone, only family glyphs) ships
  // a blank `<svg>` placeholder for the row icon.
  it('every quick-label icon name is a real lucide icon', () => {
    const bad: string[] = [];
    for (const [key, name] of Object.entries(BASH_ICONS)) {
      if (!hasIcon(name)) bad.push(`BASH_ICONS.${key} → ${name}`);
    }
    for (const [key, name] of Object.entries(TOOL_ICONS)) {
      if (!hasIcon(name)) bad.push(`TOOL_ICONS.${key} → ${name}`);
    }
    for (const name of ['terminal', 'wrench']) {
      if (!hasIcon(name)) bad.push(`fallback → ${name}`);
    }
    expect(bad).toEqual([]);
  });

  it('bash bodies render terminal-style: command + output, dark classes', () => {
    const [, row] = messageEls(call('bash', { command: 'ls -la' }, 'total 42'));
    const body = row.querySelector('.wcmsg-bash') as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.querySelector('.wcmsg-cmd')?.textContent).toBe('$ ls -la');
    expect(body.querySelector('.wcmsg-out')?.textContent).toBe('total 42');
  });

  it('a registered slicc-bash-renderer-<cmd> takes over the bash body', () => {
    class GitRenderer extends HTMLElement {}
    if (!customElements.get('slicc-bash-renderer-git')) {
      customElements.define('slicc-bash-renderer-git', GitRenderer);
    }
    const [, row] = messageEls(call('bash', { command: 'git status' }, 'On branch main'));
    const custom = row.querySelector('slicc-bash-renderer-git') as HTMLElement & {
      command?: string;
      output?: string;
    };
    expect(custom).toBeTruthy();
    expect(custom.getAttribute('command')).toBe('git status');
    expect(custom.output).toBe('On branch main');
  });

  // Chained bash commands: the row icon is driven by the most semantically
  // meaningful segment (the "real work"), not a low-signal preamble like a
  // `cd`/`echo`/`export`. See issue #1035.
  it('ranks chained bash segments so housekeeping preambles lose the icon', () => {
    const cases: Array<[string, string]> = [
      // Housekeeping preamble loses to a known git command.
      ['cd repo && git push', 'git-branch'],
      // Pure housekeeping pipe still resolves deterministically (first wins).
      ['cd /tmp && pwd', 'corner-down-right'],
      // Env-setup housekeeping loses to curl (known network tool).
      ['export FOO=1 && curl https://x', 'globe'],
      // Echo housekeeping loses to a known command — npm beats echo here, so
      // the row picks up npm's `package` icon rather than echo's `quote`.
      ['echo hi && npm test', 'package'],
      // The `test` supplemental command outranks an echo preamble: this is
      // the literal "echo + real-command → real-command icon" case from the
      // spec, picking `flask-conical` from BASH_ICONS.test.
      ['echo hi && test foo', 'flask-conical'],
      // Pipe is also a separator.
      ['cat foo | grep bar', 'file-text'],
      // Newline is a separator.
      ['cd /tmp\ngit status', 'git-branch'],
      // `||` and `;` are separators too.
      ['true || rm -rf /tmp/x', 'trash-2'],
      ['set -e; npm install', 'package'],
    ];
    for (const [command, icon] of cases) {
      const [, row] = messageEls(call('bash', { command }, 'ok'));
      expect(row.getAttribute('icon'), command).toBe(icon);
    }
  });

  // Prototype-chain hardening: `in`/bracket access on plain objects walks the
  // prototype chain, so a segment whose program literally is `toString` (or
  // any Object.prototype member) would otherwise score as a real tool and the
  // lookup would return an inherited function — which crashes `hasIcon()`
  // (`name.replace is not a function`) while rendering the row.
  it('bash segments named after Object.prototype members fall back to terminal', () => {
    const cases: string[] = [
      'cd /tmp && toString',
      'cd /tmp && hasOwnProperty',
      'cd /tmp && valueOf',
      'cd /tmp && constructor',
    ];
    for (const command of cases) {
      const [, row] = messageEls(call('bash', { command }, 'ok'));
      expect(row.getAttribute('icon'), command).toBe('terminal');
    }
  });

  it('tool names equal to Object.prototype members fall back to wrench', () => {
    for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'constructor']) {
      const [, row] = messageEls(call(name, {}, 'ok'));
      expect(row.getAttribute('icon'), name).toBe('wrench');
    }
  });

  it('edit bodies show old/new with the diff classes; writes show added content', () => {
    const [, editRow] = messageEls(
      call('edit_file', { path: '/a.ts', old_string: 'before', new_string: 'after' }, 'ok')
    );
    expect(editRow.querySelector('.del')?.textContent).toBe('before');
    expect(editRow.querySelector('.add')?.textContent).toBe('after');

    const [, writeRow] = messageEls(call('write_file', { path: '/a.ts', content: 'body' }, 'ok'));
    expect(writeRow.querySelector('.add')?.textContent).toBe('body');
    expect(writeRow.textContent).toContain('/a.ts');
  });

  it('labels clusters via quickLabel from inputs alone — results not required', async () => {
    // Calls WITHOUT results (replays with dropped tool results, running
    // chains) must still get their purpose phrase, not the generic fallback.
    const calls = [1, 2, 3].map((i) => ({
      id: `t${i}`,
      name: 'bash',
      input: { command: `step ${i}` },
    }));
    const [, cluster] = messageEls({
      id: `m-label-${Date.now()}`,
      role: 'assistant',
      content: 'working',
      timestamp: 1,
      toolCalls: calls,
    });
    document.body.append(cluster);
    await vi.waitFor(() => {
      expect(cluster.getAttribute('label')).toBe('Push the release to main');
    });
    cluster.remove();
  });

  it('clusters 3+ tool calls (open while streaming, collapsed when settled)', () => {
    const calls = [1, 2, 3].map((i) => ({
      id: `t${i}`,
      name: 'bash',
      input: { command: `step ${i}` },
      result: 'ok',
    }));
    const settled: ChatMessage = {
      id: 'm-c',
      role: 'assistant',
      content: 'done',
      timestamp: 1,
      toolCalls: calls,
    };
    const [, cluster] = messageEls(settled);
    expect(cluster.tagName.toLowerCase()).toBe('slicc-tool-cluster');
    expect(cluster.getAttribute('count')).toBe('3');
    expect(cluster.hasAttribute('open')).toBe(false);
    expect(cluster.querySelectorAll('slicc-action-row')).toHaveLength(3);

    const streaming = { ...settled, id: 'm-s', isStreaming: true };
    const [, live] = messageEls(streaming);
    expect(live.hasAttribute('open')).toBe(true);

    // Two calls stay flat — no cluster wrapper.
    const flat: ChatMessage = { ...settled, id: 'm-f', toolCalls: calls.slice(0, 2) };
    const els = messageEls(flat);
    expect(els.map((e) => e.tagName.toLowerCase())).toEqual([
      'slicc-agent-message',
      'slicc-action-row',
      'slicc-action-row',
    ]);
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

describe('isNoApiKeyError + errorCardEl', () => {
  it('matches both no-API-key error variants by prefix', () => {
    expect(NO_API_KEY_ERROR_PREFIX).toBe('No API key configured');
    expect(isNoApiKeyError('No API key configured. Open Settings to add one.')).toBe(true);
    expect(
      isNoApiKeyError('No API key configured for provider "adobe". Open Settings to add one.')
    ).toBe(true);
    expect(isNoApiKeyError('rate limited')).toBe(false);
    expect(isNoApiKeyError('')).toBe(false);
    expect(isNoApiKeyError(null as unknown as string)).toBe(false);
  });

  it('renders the no-API-key error as a settings-action error card', () => {
    const [card] = messageEls({
      id: 'err-1',
      role: 'assistant',
      content: 'No API key configured for provider "adobe". Open Settings to add one.',
      timestamp: 1,
      error: true,
    });
    expect(card.tagName.toLowerCase()).toBe('slicc-error-card');
    expect(card.getAttribute('action')).toBe('settings');
    expect(card.getAttribute('message-id')).toBe('err-1');
    expect(card.getAttribute('message')).toContain('No API key configured');
  });

  it('keeps the retry CTA for every other error', () => {
    const [card] = messageEls({
      id: 'err-2',
      role: 'assistant',
      content: 'The model rate-limited this turn.',
      timestamp: 1,
      error: true,
    });
    expect(card.tagName.toLowerCase()).toBe('slicc-error-card');
    expect(card.hasAttribute('action')).toBe(false);
  });
});

describe('render-time lick classification + scoop-identity tags', () => {
  const IDLE_BODY =
    '[@blame-roulette-scoop idle]: Scoop "blame-roulette" has been ready for 2 minutes without receiving any work.';

  it('classifies an unstamped idle notification as a lick card tagged with the scoop', () => {
    // Histories persisted before channel stamping replay as bare user
    // messages — exactly the live regression: idle nags as user bubbles.
    const els = messageEls({ id: 'x', role: 'user', content: IDLE_BODY, timestamp: 1 });
    expect(els[0].tagName.toLowerCase()).toBe('slicc-lick-card');
    expect(els[0].getAttribute('kind')).toBe('scoop-idle');
    // The yellow tag is the SCOOP's name in the scoop's accent — not a
    // repetition of the lick name.
    expect(els[0].getAttribute('event-label')).toBe('blame-roulette');
    expect(els[0].getAttribute('hue')).toMatch(/^#/);
  });

  it('classifies completed/scoop_wait/header-marked bodies', () => {
    const completed = messageEls({
      id: 'a',
      role: 'user',
      content: '[@tool-demo-scoop completed]VFS path: /shared/x.md',
      timestamp: 1,
    });
    expect(completed[0].getAttribute('kind')).toBe('scoop-notify');
    expect(completed[0].getAttribute('event-label')).toBe('tool-demo');

    const wait = messageEls({
      id: 'b',
      role: 'user',
      content: '[scoop_wait completed]1 completed, 0 timed out',
      timestamp: 1,
    });
    expect(wait[0].getAttribute('kind')).toBe('scoop-wait');

    const sprinkle = messageEls({
      id: 'c',
      role: 'user',
      content: '[Sprinkle Event: blame-roulette]\n{"action":"x"}',
      timestamp: 1,
    });
    expect(sprinkle[0].tagName.toLowerCase()).toBe('slicc-lick-card');
    expect(sprinkle[0].getAttribute('kind')).toBe('sprinkle');
    expect(sprinkle[0].getAttribute('event-label')).toBe('blame-roulette');

    // Sudo-request bodies are emitted by `Orchestrator.formatSudoRequestNotification`
    // as `[@<scoop> sudo-request]…` — both the body-marker classifier and
    // the scoop-name extractor must recognize this marker so a replayed
    // sudo request hydrates into a scoop-tagged lick card instead of a
    // plain user bubble.
    const sudo = messageEls({
      id: 'd',
      role: 'user',
      content:
        '[@pr1003-always-scoop sudo-request]\nRequest ID: sudo-mqf7gh5c-cr56age9\nKind: command\nDetail: date -u',
      timestamp: 1,
    });
    expect(sudo[0].tagName.toLowerCase()).toBe('slicc-lick-card');
    expect(sudo[0].getAttribute('kind')).toBe('sudo-request');
    expect(sudo[0].getAttribute('event-label')).toBe('pr1003-always');
  });

  it('leaves genuine user text with brackets alone', () => {
    const els = messageEls({
      id: 'd',
      role: 'user',
      content: '[link]: see https://example.com for details',
      timestamp: 1,
    });
    expect(els[0].tagName.toLowerCase()).toBe('slicc-user-message');
  });

  it('collates a run of historic unstamped idle notifications into one ×N card', () => {
    const run = collateLickMessages([
      { id: '1', role: 'user', content: IDLE_BODY, timestamp: 1 },
      { id: '2', role: 'user', content: IDLE_BODY, timestamp: 2 },
      { id: '3', role: 'user', content: IDLE_BODY, timestamp: 3 },
    ]);
    expect(run).toHaveLength(1);
    expect(run[0].lickCount).toBe(3);
    expect(run[0].channel).toBe('scoop-idle');
  });
});
