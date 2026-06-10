/**
 * Tests for transcript-limits — the per-tool-call size caps applied at
 * the chat-transcript boundary (bridge buffers, emitted agent events,
 * restored-history rebuilds). The canonical agent history is NEVER
 * capped; these limits exist so a session's UI transcript cannot grow
 * ~1:1 with tool output and OOM the agent realm / panel.
 */

import { describe, expect, it } from 'vitest';
import {
  capTranscriptText,
  capTranscriptToolInput,
  capTranscriptToolResultForBuffer,
  capTranscriptToolResultForEvent,
  MAX_TRANSCRIPT_TOOL_TEXT_CHARS,
} from '../../src/scoops/transcript-limits.js';

const IMG_MARKER = `<img:data:image/png;base64,${'A'.repeat(200_000)}>`;

describe('capTranscriptText', () => {
  it('returns short text unchanged (identity, not a copy with marker)', () => {
    expect(capTranscriptText('hello')).toBe('hello');
    expect(capTranscriptText('')).toBe('');
  });

  it('returns text exactly at the cap unchanged', () => {
    const text = 'x'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS);
    expect(capTranscriptText(text)).toBe(text);
  });

  it('caps oversized text and appends a truncation marker', () => {
    const text = 'y'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 1000);
    const capped = capTranscriptText(text);

    expect(capped.length).toBeLessThan(text.length);
    expect(capped.startsWith('y'.repeat(100))).toBe(true);
    expect(capped).toContain('truncated for the chat transcript');
    // The marker must not blow the budget itself.
    expect(capped.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 200);
  });

  it('respects a custom cap', () => {
    const capped = capTranscriptText('z'.repeat(100), 10);
    expect(capped.startsWith('zzzzzzzzzz')).toBe(true);
    expect(capped).toContain('truncated');
  });
});

describe('capTranscriptToolInput', () => {
  it('passes through primitives and small values untouched', () => {
    expect(capTranscriptToolInput(42)).toBe(42);
    expect(capTranscriptToolInput(null)).toBe(null);
    expect(capTranscriptToolInput(undefined)).toBe(undefined);
    expect(capTranscriptToolInput('small')).toBe('small');
  });

  it('caps an oversized string input', () => {
    const capped = capTranscriptToolInput('a'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 10));
    expect(typeof capped).toBe('string');
    expect((capped as string).length).toBeLessThan(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 200);
  });

  it('shallow-caps string fields of an object while preserving shape', () => {
    const input = {
      path: '/workspace/big.txt',
      content: 'c'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 5000),
      mode: 0o644,
      nested: { keep: 'me' },
    };
    const capped = capTranscriptToolInput(input) as typeof input;

    expect(capped).not.toBe(input); // copy, not mutation
    expect(capped.path).toBe('/workspace/big.txt');
    expect(capped.mode).toBe(0o644);
    expect(capped.nested).toEqual({ keep: 'me' });
    expect(capped.content.length).toBeLessThan(input.content.length);
    expect(capped.content).toContain('truncated');
    // Original untouched.
    expect(input.content.length).toBe(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 5000);
  });

  it('returns the same object reference when nothing needs capping', () => {
    const input = { command: 'ls -la' };
    expect(capTranscriptToolInput(input)).toBe(input);
  });
});

describe('capTranscriptToolResultForBuffer', () => {
  it('strips inline screenshot markers and notes the omission', () => {
    const result = `Screenshot saved.\n${IMG_MARKER}`;
    const buffered = capTranscriptToolResultForBuffer(result);

    expect(buffered).not.toContain('base64');
    expect(buffered).toContain('Screenshot saved.');
    expect(buffered).toContain('[screenshot omitted from transcript]');
  });

  it('replaces an image-only result with a placeholder', () => {
    expect(capTranscriptToolResultForBuffer(IMG_MARKER)).toBe('[screenshot]');
  });

  it('caps plain oversized results like capTranscriptText', () => {
    const huge = 'q'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 10_000);
    const buffered = capTranscriptToolResultForBuffer(huge);
    expect(buffered.length).toBeLessThan(huge.length);
    expect(buffered).toContain('truncated for the chat transcript');
  });

  it('passes small plain results through unchanged', () => {
    expect(capTranscriptToolResultForBuffer('ok')).toBe('ok');
  });
});

describe('capTranscriptToolResultForEvent', () => {
  it('keeps results at or under the cap unchanged, images included', () => {
    const small = `done\n${'<img:data:image/png;base64,AAAA>'}`;
    expect(capTranscriptToolResultForEvent(small)).toBe(small);
  });

  it('preserves image markers WHOLE while capping surrounding text', () => {
    const hugeText = 't'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 50_000);
    const result = `${hugeText}\n${IMG_MARKER}`;
    const emitted = capTranscriptToolResultForEvent(result);

    // The full marker must survive byte-for-byte (a mid-base64 cut
    // breaks the panel's screenshot extraction).
    expect(emitted).toContain(IMG_MARKER);
    expect(emitted.length).toBeLessThan(result.length);
    expect(emitted).toContain('truncated for the chat transcript');
  });

  it('caps plain oversized results without images', () => {
    const huge = 'p'.repeat(MAX_TRANSCRIPT_TOOL_TEXT_CHARS + 10_000);
    const emitted = capTranscriptToolResultForEvent(huge);
    expect(emitted.length).toBeLessThan(huge.length);
  });
});
