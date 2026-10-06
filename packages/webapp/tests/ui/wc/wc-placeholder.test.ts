// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { wellFormed } from '../../../src/base/utf16-clip.js';
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

  it('truncates without splitting a surrogate pair (well-formed for quickLabel)', () => {
    const assistantMax = 800;

    const assistant = `${'x'.repeat(assistantMax - 1)}😀${'y'.repeat(50)}`;
    const transcript = placeholderTranscript([
      msg('user', 'follow up'),
      msg('assistant', assistant),
    ]);
    expect(transcript).not.toBeNull();
    expect(transcript).toBe(wellFormed(transcript!));
    expect(JSON.parse(JSON.stringify(transcript))).toBe(transcript);
    for (let i = 0; i < transcript!.length; i++) {
      const code = transcript!.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = transcript!.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i += 1;
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
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

    await vi.waitFor(
      () => {
        expect(inputCard.getAttribute('placeholder')).toBe('default');
      },
      { timeout: 10000 }
    );
    expect(inputCard.hasAttribute('suggestion')).toBe(false);
  }, 15000);
});
