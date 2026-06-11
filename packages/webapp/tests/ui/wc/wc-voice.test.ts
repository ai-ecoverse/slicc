// @vitest-environment jsdom
/**
 * Voice wiring tests: transcript appending and the mic affordance.
 */

import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';
import { appendTranscript, wireWcVoice } from '../../../src/ui/wc/wc-voice.js';

describe('appendTranscript', () => {
  it('appends with a space separator when needed', () => {
    const card = document.createElement('slicc-input-card');
    appendTranscript(card, 'hello');
    expect(card.getAttribute('value')).toBe('hello');
    appendTranscript(card, 'world');
    expect(card.getAttribute('value')).toBe('hello world');
    card.setAttribute('value', 'trailing ');
    appendTranscript(card, 'space');
    expect(card.getAttribute('value')).toBe('trailing space');
  });
});

describe('wireWcVoice', () => {
  it('adds a mic toggle to the composer meta row', async () => {
    const composerMeta = document.createElement('slicc-composer-meta');
    const inputCard = document.createElement('slicc-input-card');
    document.body.append(composerMeta, inputCard);
    const refs = { composerMeta, inputCard } as unknown as WcShellRefs;

    await wireWcVoice({ refs, send: vi.fn(), log: { warn: vi.fn() } as never });
    const mic = composerMeta.querySelector('slicc-icon-button');
    expect(mic?.getAttribute('icon')).toBe('mic');
    expect(mic?.getAttribute('label')).toBe('Voice input');
  });
});
