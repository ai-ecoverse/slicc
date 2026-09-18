import { describe, expect, it } from 'vitest';
import {
  isExhaustedBudgetError,
  isUserFixableError,
  parseExhaustedBudgetError,
} from '../../src/core/error-families.js';

const ADOBE_429 =
  '429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used. Resets on 2026-09-14. You can also connect your own LLM provider.","resets_at":"2026-09-14T00:00:00.000Z"}}';

const GROK_403 =
  '403 {"code":"The caller does not have permission to execute the specified operation","error":"You have either run out of available resources or do not have an active Grok subscription. Manage your subscription at https://grok.com/?_s=usage or subscribe at https://grok.com/supergrok."}';

describe('isExhaustedBudgetError', () => {
  it('matches the Adobe proxy 429 envelope', () => {
    expect(isExhaustedBudgetError(ADOBE_429)).toBe(true);
  });

  it('matches the Grok 403 credit/subscription refusal', () => {
    expect(isExhaustedBudgetError(GROK_403)).toBe(true);
  });

  it.each([ADOBE_429, GROK_403])('matches through a scoop unrecoverable-error wrapper', (error) => {
    expect(isExhaustedBudgetError(`Scoop "digest" failed with unrecoverable error: ${error}`)).toBe(
      true
    );
  });

  it('does not match neighbouring error families or empty input', () => {
    expect(
      isExhaustedBudgetError('403 {"error":{"type":"forbidden","message":"Model not allowed"}}')
    ).toBe(false);
    expect(isExhaustedBudgetError('Adobe session expired — please log in again')).toBe(false);
    expect(isExhaustedBudgetError('429 Too Many Requests')).toBe(false);
    expect(isExhaustedBudgetError('403 Forbidden')).toBe(false);

    expect(
      isExhaustedBudgetError('403 You have run out of credits and need a subscription to continue.')
    ).toBe(false);
    expect(isExhaustedBudgetError('')).toBe(false);
    expect(isExhaustedBudgetError(null)).toBe(false);
    expect(isExhaustedBudgetError(undefined)).toBe(false);

    expect(isExhaustedBudgetError({ message: 'quota_exceeded' } as never)).toBe(false);
    expect(isUserFixableError({ message: 'please log in again' } as never)).toBe(false);
  });
});

describe('parseExhaustedBudgetError', () => {
  it('extracts the provider message and reset instant', () => {
    expect(parseExhaustedBudgetError(ADOBE_429)).toEqual({
      message: 'Weekly budget has been fully used. Resets on 2026-09-14.',
      resetsAt: '2026-09-14T00:00:00.000Z',
    });
  });

  it('drops the trailing "connect your own LLM provider" sentence the CTAs replace', () => {
    expect(parseExhaustedBudgetError(ADOBE_429)?.message).not.toContain('connect your own');
  });

  it('turns the Grok refusal into provider-appropriate prose without adapter noise', () => {
    expect(parseExhaustedBudgetError(GROK_403)).toEqual({
      message: 'Your Grok account has run out of credits or does not have an active subscription.',
      resetsAt: null,
    });
  });

  it.each([
    [ADOBE_429, '2026-09-14T00:00:00.000Z'],
    [GROK_403, null],
  ])('parses through a wrapper prefix that precedes the provider error', (error, resetsAt) => {
    const wrapped = `Scoop "digest" failed with unrecoverable error: ${error}`;
    expect(parseExhaustedBudgetError(wrapped)?.resetsAt).toBe(resetsAt);
  });

  it('falls back to generic copy — never raw JSON — for a message-less envelope', () => {
    const detail = parseExhaustedBudgetError('429 {"error":{"type":"quota_exceeded"}}');
    expect(detail).toEqual({
      message: 'The usage budget for this provider has been fully used.',
      resetsAt: null,
    });
  });

  it('still yields a detail when the envelope is truncated mid-JSON', () => {
    const detail = parseExhaustedBudgetError(
      '429 {"error":{"type":"quota_exceeded","message":"Wee'
    );
    expect(detail?.message).toBe('The usage budget for this provider has been fully used.');
    expect(detail?.resetsAt).toBeNull();
  });

  it('ignores non-string message / resets_at fields', () => {
    const detail = parseExhaustedBudgetError(
      '429 {"error":{"type":"quota_exceeded","message":42,"resets_at":0}}'
    );
    expect(detail?.message).toBe('The usage budget for this provider has been fully used.');
    expect(detail?.resetsAt).toBeNull();
  });

  it('returns null for anything outside the family', () => {
    expect(parseExhaustedBudgetError('No API key configured')).toBeNull();
    expect(parseExhaustedBudgetError(null)).toBeNull();
  });
});

describe('isUserFixableError', () => {
  it('covers both exhausted-budget provider shapes alongside the other families', () => {
    expect(isUserFixableError(ADOBE_429)).toBe(true);
    expect(isUserFixableError(GROK_403)).toBe(true);
    expect(isUserFixableError('No API key configured for provider "adobe".')).toBe(true);
    expect(isUserFixableError('Model not allowed: claude-opus-4-6')).toBe(true);
    expect(isUserFixableError('please log in again')).toBe(true);
    expect(isUserFixableError('The agent turn failed.')).toBe(false);
  });
});
