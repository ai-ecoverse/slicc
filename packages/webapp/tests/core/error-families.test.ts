/**
 * The `quota_exceeded` family — detection and envelope parsing. The other
 * three families are covered through the render path in
 * `tests/ui/wc/wc-message-view.test.ts`; this one carries a parser, so it gets
 * its own DOM-free suite.
 */

import { describe, expect, it } from 'vitest';
import {
  isQuotaExceededError,
  isUserFixableError,
  parseQuotaExceededError,
} from '../../src/core/error-families.js';

/** The verbatim Adobe proxy refusal, as it reaches the error card. */
const ADOBE_429 =
  '429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used. Resets on 2026-09-14. You can also connect your own LLM provider.","resets_at":"2026-09-14T00:00:00.000Z"}}';

describe('isQuotaExceededError', () => {
  it('matches the Adobe proxy 429 envelope', () => {
    expect(isQuotaExceededError(ADOBE_429)).toBe(true);
  });

  it('matches through a scoop unrecoverable-error wrapper', () => {
    expect(
      isQuotaExceededError(`Scoop "digest" failed with unrecoverable error: ${ADOBE_429}`)
    ).toBe(true);
  });

  it('does not match neighbouring error families or empty input', () => {
    expect(
      isQuotaExceededError('403 {"error":{"type":"forbidden","message":"Model not allowed"}}')
    ).toBe(false);
    expect(isQuotaExceededError('Adobe session expired — please log in again')).toBe(false);
    expect(isQuotaExceededError('429 Too Many Requests')).toBe(false);
    expect(isQuotaExceededError('')).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
  });
});

describe('parseQuotaExceededError', () => {
  it('extracts the provider message and reset instant', () => {
    expect(parseQuotaExceededError(ADOBE_429)).toEqual({
      message: 'Weekly budget has been fully used. Resets on 2026-09-14.',
      resetsAt: '2026-09-14T00:00:00.000Z',
    });
  });

  it('drops the trailing "connect your own LLM provider" sentence the CTAs replace', () => {
    expect(parseQuotaExceededError(ADOBE_429)?.message).not.toContain('connect your own');
  });

  it('parses through a wrapper prefix that precedes the JSON', () => {
    const wrapped = `Scoop "digest" failed with unrecoverable error: ${ADOBE_429}`;
    expect(parseQuotaExceededError(wrapped)?.resetsAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('falls back to generic copy — never raw JSON — for a message-less envelope', () => {
    const detail = parseQuotaExceededError('429 {"error":{"type":"quota_exceeded"}}');
    expect(detail).toEqual({
      message: 'The usage budget for this provider has been fully used.',
      resetsAt: null,
    });
  });

  it('still yields a detail when the envelope is truncated mid-JSON', () => {
    // The family is established by the type token; a parse miss must not fall
    // back to dumping a broken payload at the user.
    const detail = parseQuotaExceededError('429 {"error":{"type":"quota_exceeded","message":"Wee');
    expect(detail?.message).toBe('The usage budget for this provider has been fully used.');
    expect(detail?.resetsAt).toBeNull();
  });

  it('ignores non-string message / resets_at fields', () => {
    const detail = parseQuotaExceededError(
      '429 {"error":{"type":"quota_exceeded","message":42,"resets_at":0}}'
    );
    expect(detail?.message).toBe('The usage budget for this provider has been fully used.');
    expect(detail?.resetsAt).toBeNull();
  });

  it('returns null for anything outside the family', () => {
    expect(parseQuotaExceededError('No API key configured')).toBeNull();
    expect(parseQuotaExceededError(null)).toBeNull();
  });
});

describe('isUserFixableError', () => {
  it('covers the quota family alongside the other three', () => {
    expect(isUserFixableError(ADOBE_429)).toBe(true);
    expect(isUserFixableError('No API key configured for provider "adobe".')).toBe(true);
    expect(isUserFixableError('Model not allowed: claude-opus-4-6')).toBe(true);
    expect(isUserFixableError('please log in again')).toBe(true);
    expect(isUserFixableError('The agent turn failed.')).toBe(false);
  });
});
