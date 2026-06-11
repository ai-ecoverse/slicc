// @vitest-environment jsdom
/**
 * Copy-affordance tests: the press-button row after the last reply (legacy
 * feedback-row parity) — short click copies the latest completed assistant
 * response, long press the whole chat.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { ChatMessage } from '../../../src/ui/types.js';
import { createCopyRow, lastAssistantText } from '../../../src/ui/wc/wc-copy-row.js';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return { id: 'm', role: 'user', content: '', timestamp: 1, ...partial } as ChatMessage;
}

describe('lastAssistantText', () => {
  it('returns the most recent COMPLETED assistant message', () => {
    const text = lastAssistantText([
      msg({ role: 'assistant', content: 'old reply' }),
      msg({ role: 'user', content: 'q' }),
      msg({ role: 'assistant', content: 'latest reply' }),
      msg({ role: 'assistant', content: 'still streaming', isStreaming: true }),
    ]);
    expect(text).toBe('latest reply');
  });

  it('falls back to a streaming reply only when nothing is settled', () => {
    expect(
      lastAssistantText([msg({ role: 'assistant', content: 'partial', isStreaming: true })])
    ).toBe('partial');
    expect(lastAssistantText([msg({ role: 'user', content: 'q' })])).toBeNull();
  });
});

describe('createCopyRow', () => {
  it('short-click copies the last response; long-press the whole chat', async () => {
    const messages = [
      msg({ role: 'user', content: 'fix the build' }),
      msg({ role: 'assistant', content: 'done — green again' }),
    ];
    const writes: string[] = [];
    const row = createCopyRow({
      getMessages: () => messages,
      writeText: async (text) => {
        writes.push(text);
      },
    });
    document.body.append(row);
    const btn = row.querySelector('slicc-press-button') as HTMLElement;
    expect(btn).toBeTruthy();
    expect(btn.querySelector('svg')).toBeTruthy();

    btn.dispatchEvent(new CustomEvent('short-click'));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toBe('done — green again');

    btn.dispatchEvent(new CustomEvent('long-press'));
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toContain('## User');
    expect(writes[1]).toContain('fix the build');
    expect(writes[1]).toContain('## Assistant');
  });
});
