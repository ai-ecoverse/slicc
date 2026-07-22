import { describe, expect, it } from 'vitest';
import { CloudError, isCloudError } from '../src/errors.js';

describe('isCloudError', () => {
  it('returns true for a CloudError instance', () => {
    const err = new CloudError('NOT_FOUND', 'cone not found');
    expect(isCloudError(err)).toBe(true);
  });

  it('returns false for a plain Error', () => {
    expect(isCloudError(new Error('boom'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isCloudError('boom')).toBe(false);
    expect(isCloudError(undefined)).toBe(false);
  });
});
