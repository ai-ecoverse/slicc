// @vitest-environment jsdom
/**
 * Suggested-placeholder behavior: transcript shaping, fail-soft fallbacks,
 * and the user's-draft-wins guarantee — with the quick-LLM call faked.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { ChatMessage } from '../../../src/ui/types.js';
import {
  applySuggestedPlaceholder,
  createPlaceholderRefresher,
  placeholderTranscript,
  refreshSuggestedPlaceholder,
} from '../../../src/ui/wc/wc-placeholder.js';

function msg(
  role: 'user' | 'assistant',
  content: string,
  extra?: Partial<ChatMessage>
): ChatMessage {
  return { id: `m-${content}`, role, content, timestamp: 1, ...extra };
}

describe('placeholderTranscript', () => {
  it('needs at least one user turn and one finalized assistant turn', () => {
    expect(placeholderTranscript([])).toBeNull();
    expect(placeholderTranscript([msg('user', 'hi')])).toBeNull();
    expect(placeholderTranscript([msg('assistant', 'hello')])).toBeNull();
    expect(
      placeholderTranscript([
        msg('user', 'hi'),
        msg('assistant', 'streaming', { isStreaming: true }),
      ])
    ).toBeNull();
  });

  it('keeps the last 3 user turns and the last assistant turn, ignoring licks and queued', () => {
    const transcript = placeholderTranscript([
      msg('user', 'one'),
      msg('user', 'two'),
      msg('user', 'three'),
      msg('user', 'lick noise', { source: 'lick', channel: 'cron' }),
      msg('user', 'four'),
      msg('assistant', 'older answer'),
      msg('assistant', 'final answer'),
      msg('user', 'queued draft', { queued: true }),
    ]);
    expect(transcript).toContain('[user]: two');
    expect(transcript).toContain('[user]: four');
    expect(transcript).not.toContain('one');
    expect(transcript).not.toContain('lick noise');
    expect(transcript).not.toContain('queued draft');
    expect(transcript).toContain('[assistant]: final answer');
    expect(transcript).not.toContain('older answer');
  });
});

describe('refreshSuggestedPlaceholder', () => {
  const conversation = [msg('user', 'build a shader'), msg('assistant', 'done — shipped it')];

  it('sets the suggestion from the quick-LLM call', async () => {
    const setPlaceholder = vi.fn();
    await refreshSuggestedPlaceholder({
      messages: conversation,
      currentValue: '',
      setPlaceholder,
      defaultPlaceholder: 'default',
      quickLabelFn: async () => 'Now add dark mode?',
    });
    expect(setPlaceholder).toHaveBeenCalledWith('Now add dark mode?');
  });

  it('falls back to the default when the call fails or the chat is thin', async () => {
    const setPlaceholder = vi.fn();
    await refreshSuggestedPlaceholder({
      messages: conversation,
      currentValue: '',
      setPlaceholder,
      defaultPlaceholder: 'default',
      quickLabelFn: async () => null,
    });
    expect(setPlaceholder).toHaveBeenCalledWith('default');

    setPlaceholder.mockClear();
    await refreshSuggestedPlaceholder({
      messages: [msg('user', 'only me')],
      currentValue: '',
      setPlaceholder,
      defaultPlaceholder: 'default',
      quickLabelFn: async () => 'never called',
    });
    expect(setPlaceholder).toHaveBeenCalledWith('default');
  });

  it("never disturbs the user's draft", async () => {
    const setPlaceholder = vi.fn();
    await refreshSuggestedPlaceholder({
      messages: conversation,
      currentValue: 'half-typed prompt',
      setPlaceholder,
      defaultPlaceholder: 'default',
      quickLabelFn: async () => 'suggestion',
    });
    expect(setPlaceholder).not.toHaveBeenCalled();
  });
});

describe('applySuggestedPlaceholder', () => {
  it('lands a real suggestion on the suggestion attribute (Tab-to-accept)', () => {
    const inputCard = document.createElement('slicc-input-card');
    inputCard.setAttribute('placeholder', 'default');
    applySuggestedPlaceholder(inputCard, 'Now add dark mode?', 'default');
    expect(inputCard.getAttribute('suggestion')).toBe('Now add dark mode?');
    // The static placeholder stays in place beneath the suggestion.
    expect(inputCard.getAttribute('placeholder')).toBe('default');
  });

  it('restores the plain placeholder and clears a stale suggestion on the default', () => {
    const inputCard = document.createElement('slicc-input-card');
    inputCard.setAttribute('suggestion', 'stale suggestion');
    applySuggestedPlaceholder(inputCard, 'default', 'default');
    expect(inputCard.hasAttribute('suggestion')).toBe(false);
    expect(inputCard.getAttribute('placeholder')).toBe('default');
  });
});

describe('createPlaceholderRefresher', () => {
  it('writes the refreshed placeholder onto the input card, skipping disabled (frozen) views', async () => {
    const inputCard = document.createElement('slicc-input-card') as HTMLElement & {
      value?: string;
    };
    document.body.appendChild(inputCard);
    const refresh = createPlaceholderRefresher({
      inputCard,
      getMessages: () => [msg('user', 'a'), msg('assistant', 'b')],
      defaultPlaceholder: 'default',
    });

    inputCard.setAttribute('disabled', '');
    refresh();
    expect(inputCard.getAttribute('placeholder')).toBeNull();

    inputCard.removeAttribute('disabled');
    refresh();
    // The real quick-llm path resolves null in tests (no provider/key) —
    // fail-soft means the default lands as the plain placeholder, with no
    // Tab-acceptable suggestion left behind.
    await vi.waitFor(() => {
      expect(inputCard.getAttribute('placeholder')).toBe('default');
    });
    expect(inputCard.hasAttribute('suggestion')).toBe(false);
  });
});
