import { describe, expect, it } from 'vitest';
import {
  errorDetailsToRawString,
  formatErrorDetails,
  unwrapStructuredErrorMessage,
} from '../../src/core/error-text.js';

describe('errorDetailsToRawString', () => {
  it('returns strings unchanged', () => {
    expect(errorDetailsToRawString('rate_limit')).toBe('rate_limit');
  });

  it('formats Error as name: message (generic Error drops the name)', () => {
    expect(errorDetailsToRawString(new Error('boom'))).toBe('boom');
    expect(errorDetailsToRawString(new TypeError('x is not a function'))).toBe(
      'TypeError: x is not a function'
    );
  });

  it('extracts allowlisted message fields instead of String() → [object Object]', () => {
    expect(errorDetailsToRawString({ message: 'bedrock returned 400' })).toBe(
      'bedrock returned 400'
    );
    expect(String({ message: 'bedrock returned 400' })).toBe('[object Object]');
  });

  it('keeps error.type next to the message so quota_exceeded still filters', () => {
    expect(
      errorDetailsToRawString({
        error: { type: 'quota_exceeded', message: 'Weekly budget has been fully used.' },
      })
    ).toBe('quota_exceeded: Weekly budget has been fully used.');
  });

  it('drops unknown object bags rather than serializing them', () => {
    expect(
      errorDetailsToRawString({ token: 'secret', request: { url: '/join/abc' } })
    ).toBeUndefined();
    expect(errorDetailsToRawString(null)).toBeUndefined();
    expect(errorDetailsToRawString(undefined)).toBeUndefined();
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(errorDetailsToRawString(circular)).toBeUndefined();
  });

  it('stringifies primitives without wrapping', () => {
    expect(errorDetailsToRawString(404)).toBe('404');
    expect(errorDetailsToRawString(true)).toBe('true');
  });
});

describe('unwrapStructuredErrorMessage', () => {
  it('unwraps a {message} JSON blob', () => {
    expect(
      unwrapStructuredErrorMessage(
        '{"message":"The system encountered an unexpected error during processing"}'
      )
    ).toBe('The system encountered an unexpected error during processing');
  });

  it('unwraps nested error.message (upstream_error / bedrock 400 family)', () => {
    expect(
      unwrapStructuredErrorMessage(
        '{"type":"error","error":{"type":"upstream_error","message":"bedrock returned 400"}}'
      )
    ).toBe('bedrock returned 400');
  });

  it('unwraps a JSON object embedded after a status prefix', () => {
    expect(
      unwrapStructuredErrorMessage(
        '429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used."}}'
      )
    ).toBe('Weekly budget has been fully used.');
  });

  it('leaves ordinary strings alone', () => {
    expect(unwrapStructuredErrorMessage('network error')).toBe('network error');
    expect(unwrapStructuredErrorMessage('[object Object]')).toBe('[object Object]');
  });
});

describe('formatErrorDetails', () => {
  it('unwraps object details to the message, never [object Object]', () => {
    expect(formatErrorDetails({ message: 'bedrock returned 400' })).toBe('bedrock returned 400');
    expect(
      formatErrorDetails({
        type: 'error',
        error: { type: 'upstream_error', message: 'bedrock returned 400' },
      })
    ).toBe('bedrock returned 400');
    expect(formatErrorDetails({ message: 'bedrock returned 400' })).not.toBe('[object Object]');
  });

  it('formats Error instances', () => {
    expect(formatErrorDetails(new TypeError('cannot read x'))).toBe('TypeError: cannot read x');
  });

  it('does not serialize secret-bearing bags', () => {
    expect(
      formatErrorDetails({ token: 'secret', headers: { authorization: 'Bearer x' } })
    ).toBeUndefined();
  });
});
