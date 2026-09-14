import { describe, expect, it } from 'vitest';
import {
  createChatFixture,
  FIXTURE_SCOOP_NAME,
  FIXTURE_SESSION_ID,
} from '../../src/ui/chat-fixture.js';

describe('createChatFixture', () => {
  const msgs = createChatFixture();
  const byId = new Map(msgs.map((m) => [m.id, m]));

  it('returns a stable, non-empty message list', () => {
    expect(msgs.length).toBeGreaterThan(5);

    const second = createChatFixture();
    expect(second).toEqual(msgs);
  });

  it('uses deterministic timestamps (no Date.now drift)', () => {
    const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp);
    expect(sorted.map((m) => m.id)).toEqual(msgs.map((m) => m.id));
    expect(new Date(msgs[0].timestamp).getFullYear()).toBe(2024);
  });

  it('includes at least one user message and one assistant message', () => {
    expect(msgs.some((m) => m.role === 'user' && !m.source)).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('covers every lick channel', () => {
    const channels = new Set(msgs.filter((m) => m.source === 'lick').map((m) => m.channel));
    expect([...channels].sort()).toEqual(
      [
        'cron',
        'fswatch',
        'navigate',
        'preview',
        'session-reload',
        'sprinkle',
        'sudo-request',
        'upgrade',
        'webhook',
      ].sort()
    );
  });

  it('includes the attributed Preview Event variant', () => {
    const previewEvent = byId.get('fx-lick-preview-event');
    expect(previewEvent).toBeDefined();
    expect(previewEvent!.content).toContain('Preview event');
    expect(previewEvent!.content).toContain('preview:tok--sec:conn-42');
  });

  it('exercises every actionable-lick (sudo-request) card state', () => {
    const states = msgs
      .filter((m) => m.source === 'lick' && m.channel === 'sudo-request')
      .map((m) => m.lickState)
      .sort();
    expect(states).toEqual(['confirmed', 'dismissed', 'pending']);

    for (const m of msgs.filter((m) => m.source === 'lick' && m.channel === 'sudo-request')) {
      expect(m.lickId).toBeTruthy();
    }
  });

  it('includes a delegation message from cone', () => {
    expect(msgs.some((m) => m.channel === 'delegation' || m.source === 'delegation')).toBe(true);
  });

  it('includes a queued message with the `queued` flag set', () => {
    expect(msgs.some((m) => m.queued === true)).toBe(true);
  });

  it('covers every RENDERED compaction-marker state', () => {
    const states = msgs
      .map((m) => m.compaction?.state)
      .filter((state): state is NonNullable<typeof state> => state !== undefined)
      .sort();
    expect(states).toEqual(['fallback', 'summarized', 'summarizing']);
  });

  it('never stages a discarded compaction marker', () => {
    expect(msgs.some((m) => m.compaction?.state === 'discarded')).toBe(false);
  });

  it('varies the compaction trigger so each wording is exercised', () => {
    const triggers = new Set(msgs.map((m) => m.compaction?.trigger).filter(Boolean));
    expect([...triggers].sort()).toEqual(['idle', 'overflow', 'threshold']);
  });

  it('leaves compaction-marker bodies empty', () => {
    for (const m of msgs.filter((msg) => msg.compaction)) expect(m.content).toBe('');
  });

  it('includes a user message with image and text attachments', () => {
    const attachmentMsg = byId.get('fx-user-attachment');
    expect(attachmentMsg).toBeDefined();
    expect(attachmentMsg!.attachments?.map((a) => a.kind).sort()).toEqual(['image', 'text']);
  });

  it('includes tool calls in all four display states', () => {
    const allToolCalls = msgs.flatMap((m) => m.toolCalls ?? []);
    expect(allToolCalls.length).toBeGreaterThan(0);

    const running = allToolCalls.filter((tc) => tc.result === undefined);
    const success = allToolCalls.filter((tc) => tc.result !== undefined && !tc.isError);
    const failed = allToolCalls.filter((tc) => tc.isError === true);
    const withScreenshot = allToolCalls.filter((tc) => !!tc._screenshotDataUrl);

    expect(running.length).toBeGreaterThan(0);
    expect(success.length).toBeGreaterThan(0);
    expect(failed.length).toBeGreaterThan(0);
    expect(withScreenshot.length).toBeGreaterThan(0);
  });

  it('covers every scoop-management tool from scoop-management-tools.ts', () => {
    const requiredTools = [
      'send_message',
      'feed_scoop',
      'list_scoops',
      'scoop_scoop',
      'drop_scoop',
      'update_global_memory',
    ];
    const toolNames = new Set(msgs.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.name)));
    for (const name of requiredTools) {
      expect(toolNames.has(name), `fixture is missing a ${name} tool call`).toBe(true);
    }
  });

  it('includes a streaming (live) assistant message', () => {
    expect(msgs.some((m) => m.role === 'assistant' && m.isStreaming === true)).toBe(true);
  });

  it('includes a markdown-heavy assistant message with a fenced code block', () => {
    const markdownMsg = byId.get('fx-assistant-2');
    expect(markdownMsg).toBeDefined();
    expect(markdownMsg!.content).toContain('```ts');
    expect(markdownMsg!.content).toContain('## ');
  });

  it('all messages have unique ids', () => {
    const ids = msgs.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exports stable identifiers used by main.ts', () => {
    expect(FIXTURE_SESSION_ID).toBe('session-ui-fixture');
    expect(FIXTURE_SCOOP_NAME).toBe('ui-fixture');
  });
});
