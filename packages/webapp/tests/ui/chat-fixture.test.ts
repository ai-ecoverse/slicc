/**
 * Tests for the UI design-time chat fixture.
 *
 * The fixture is the single source of truth for every message UI variant
 * a designer might need to iterate on. Each test asserts a specific
 * variant is present so refactors don't accidentally drop coverage.
 */

import { describe, it, expect } from 'vitest';
import {
  createChatFixture,
  FIXTURE_SESSION_ID,
  FIXTURE_SCOOP_NAME,
} from '../../src/ui/chat-fixture.js';

describe('createChatFixture', () => {
  const msgs = createChatFixture();
  const byId = new Map(msgs.map((m) => [m.id, m]));

  it('returns a stable, non-empty message list', () => {
    expect(msgs.length).toBeGreaterThan(5);
    // Calling twice should produce structurally equal results (pure fn).
    const second = createChatFixture();
    expect(second).toEqual(msgs);
  });

  it('uses deterministic timestamps (no Date.now drift)', () => {
    // All timestamps anchor to 2024-01-01T10:00:00 local; monotonic within seconds.
    const sorted = [...msgs].sort((a, b) => a.timestamp - b.timestamp);
    expect(sorted.map((m) => m.id)).toEqual(msgs.map((m) => m.id));
    expect(new Date(msgs[0].timestamp).getFullYear()).toBe(2024);
  });

  it('includes at least one user message and one assistant message', () => {
    expect(msgs.some((m) => m.role === 'user' && !m.source)).toBe(true);
    expect(msgs.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('covers every lick channel exactly once', () => {
    const channels = msgs
      .filter((m) => m.source === 'lick')
      .map((m) => m.channel)
      .sort();
    expect(channels).toEqual(
      ['cron', 'fswatch', 'navigate', 'session-reload', 'sprinkle', 'upgrade', 'webhook'].sort()
    );
  });

  it('includes a delegation message from cone', () => {
    expect(msgs.some((m) => m.channel === 'delegation' || m.source === 'delegation')).toBe(true);
  });

  it('includes a queued message with the `queued` flag set', () => {
    expect(msgs.some((m) => m.queued === true)).toBe(true);
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
    // Keep this list in sync with the tool names registered in
    // packages/webapp/src/scoops/scoop-management-tools.ts. If you add
    // or rename a scoop-management tool, extend both the fixture and
    // this assertion so the design harness stays comprehensive.
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
