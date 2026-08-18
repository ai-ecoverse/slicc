import { describe, expect, it } from 'vitest';
import type { CloudErrorCode, CloudErrorDetails } from '../src/index.js';
import { CloudError, isCloudError } from '../src/index.js';

describe('CloudError', () => {
  it('exposes the code and message and defaults details to undefined', () => {
    const err = new CloudError('NOT_FOUND', 'cloud session not found: abc');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CloudError');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('cloud session not found: abc');
    expect(err.details).toBeUndefined();
  });

  it('carries typed cap-exceeded details', () => {
    const details: CloudErrorDetails = { running: 3, cap: 3 };
    const err = new CloudError('CAP_EXCEEDED', 'at running cap (3/3)', details);
    expect(err.details).toEqual({ running: 3, cap: 3 });
  });

  it('accepts a paused-cap details shape', () => {
    const err = new CloudError('CAP_EXCEEDED', 'at paused cap (5/5)', { paused: 5, cap: 5 });
    expect(err.details).toEqual({ paused: 5, cap: 5 });
  });
});

describe('isCloudError', () => {
  it('narrows a CloudError instance', () => {
    const err: unknown = new CloudError('INTERNAL', 'boom');
    expect(isCloudError(err)).toBe(true);
    if (isCloudError(err)) {
      const code: CloudErrorCode = err.code;
      expect(code).toBe('INTERNAL');
    }
  });

  it('rejects a plain Error and non-error values', () => {
    expect(isCloudError(new Error('nope'))).toBe(false);
    expect(isCloudError('CAP_EXCEEDED')).toBe(false);
    expect(isCloudError(null)).toBe(false);
    expect(isCloudError(undefined)).toBe(false);
  });
});
