import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDictationMarkers,
  consumeDictationFirst,
  parseReplyLang,
  resetDictationPriming,
  stripDictationMarkers,
  stripReplyLangMarker,
} from '../../src/speech/dictation-priming.js';

const MIC = '\uD83C\uDF99\uFE0F';
const LEFT = '\u25C1';
const RIGHT = '\u25B7';

describe('dictation-priming', () => {
  beforeEach(() => {
    resetDictationPriming();
  });

  describe('applyDictationMarkers', () => {
    it('first-of-session message gets the 🎙️ + ◁ priming note ▷', () => {
      const out = applyDictationMarkers('Hello world', true);
      expect(out.startsWith('Hello world ')).toBe(true);
      expect(out).toContain(MIC);
      expect(out).toContain(LEFT);
      expect(out).toContain(RIGHT);
      // The note carries the speech-friendly instructions the model needs.
      expect(out).toContain('text to speech');
      expect(out).toContain('read out loud');
      // …and asks the model to declare its reply language as a hidden marker.
      expect(out).toContain('<!--lang:en-->');
    });

    it('subsequent dictated messages get only the 🎙️ glyph', () => {
      const out = applyDictationMarkers('Try again', false);
      expect(out).toBe(`Try again ${MIC}`);
      expect(out).not.toContain(LEFT);
      expect(out).not.toContain(RIGHT);
    });

    it('preserves a single space separator when the input already ends with one', () => {
      const out = applyDictationMarkers('Trailing space ', false);
      // No double space; ends with " 🎙️".
      expect(out).toBe(`Trailing space ${MIC}`);
    });
  });

  describe('consumeDictationFirst / resetDictationPriming', () => {
    it('is one-shot per session: first call true, every later call false', () => {
      expect(consumeDictationFirst()).toBe(true);
      expect(consumeDictationFirst()).toBe(false);
      expect(consumeDictationFirst()).toBe(false);
    });

    it('reset re-arms the first-message flag', () => {
      consumeDictationFirst();
      expect(consumeDictationFirst()).toBe(false);
      resetDictationPriming();
      expect(consumeDictationFirst()).toBe(true);
      expect(consumeDictationFirst()).toBe(false);
    });
  });

  describe('stripDictationMarkers', () => {
    it('round-trips: applyDictationMarkers → strip recovers the clean text (first turn)', () => {
      const clean = 'Hello world';
      expect(stripDictationMarkers(applyDictationMarkers(clean, true))).toBe(clean);
    });

    it('round-trips: applyDictationMarkers → strip recovers the clean text (later turn)', () => {
      const clean = 'Tell me a joke';
      expect(stripDictationMarkers(applyDictationMarkers(clean, false))).toBe(clean);
    });

    it('removes a standalone 🎙️ anywhere in the text', () => {
      expect(stripDictationMarkers(`hi ${MIC} there`)).toBe('hi  there'.trimEnd());
      expect(stripDictationMarkers(`${MIC}leading`)).toBe('leading');
    });

    it('removes any ◁ … ▷ region, multi-line tolerant', () => {
      const text = `hello ${LEFT}one\ntwo\nthree${RIGHT} tail`;
      expect(stripDictationMarkers(text)).toBe('hello  tail'.trimEnd());
    });

    it('removes the 🎙️ glyph even without its VS16 variation selector', () => {
      const bareMic = '\uD83C\uDF99';
      expect(stripDictationMarkers(`text ${bareMic}`)).toBe('text');
    });

    it('messages that are ONLY markers strip down to the empty string', () => {
      expect(stripDictationMarkers(`${MIC}${LEFT}note${RIGHT}`)).toBe('');
      expect(stripDictationMarkers(applyDictationMarkers('', true).trimStart())).toBe('');
    });

    it('typed (non-dictated) messages pass through untouched', () => {
      const typed = 'Plain typed message — no markers here.';
      expect(stripDictationMarkers(typed)).toBe(typed);
    });
  });

  describe('parseReplyLang', () => {
    it('reads the BCP-47 tag from a leading <!--lang:xx--> marker', () => {
      expect(parseReplyLang('<!--lang:de-->Hallo Welt')).toBe('de');
      expect(parseReplyLang('<!--lang:en-US-->Hello')).toBe('en-US');
    });

    it('tolerates surrounding whitespace and is case-insensitive on the tag', () => {
      expect(parseReplyLang('<!-- lang: pt-BR -->Olá')).toBe('pt-BR');
    });

    it('finds the marker even when it is not at the very start', () => {
      expect(parseReplyLang('Hello\n<!--lang:fr-->')).toBe('fr');
    });

    it('returns undefined when no marker is present', () => {
      expect(parseReplyLang('Just a plain reply')).toBeUndefined();
      expect(parseReplyLang('<!--not-a-lang-marker-->')).toBeUndefined();
    });
  });

  describe('stripReplyLangMarker', () => {
    it('removes the reply-language marker, leaving the rest intact', () => {
      expect(stripReplyLangMarker('<!--lang:de-->Hallo Welt')).toBe('Hallo Welt');
    });

    it('removes every marker when more than one is present', () => {
      expect(stripReplyLangMarker('<!--lang:en-->a<!--lang:de-->b')).toBe('ab');
    });

    it('leaves marker-free text untouched', () => {
      const text = 'No markers — just prose.';
      expect(stripReplyLangMarker(text)).toBe(text);
    });
  });
});
