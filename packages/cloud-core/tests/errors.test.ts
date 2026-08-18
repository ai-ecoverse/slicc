import { describe, expect, it } from 'vitest';
import type { CloudErrorDetails } from '../src/index.js';
import { CloudError, isCloudError } from '../src/index.js';

describe('CloudError', () => {
  it('carries the code and message, and names itself', () => {
    const err = new CloudError('NOT_FOUND', 'cloud session not found: foo');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('cloud session not found: foo');
    expect(err.name).toBe('CloudError');
    expect(err.details).toBeUndefined();
  });

  it('preserves typed cap-exceeded details', () => {
    const details: CloudErrorDetails = { running: 1, cap: 1 };
    const err = new CloudError('CAP_EXCEEDED', 'at running cap (1/1)', details);
    expect(err.details).toEqual({ running: 1, cap: 1 });
  });

  it('preserves the sandboxId on a boot failure', () => {
    const err = new CloudError('SANDBOX_NOT_READY', 'boot failed', { sandboxId: 'sbx-1' });
    expect(err.details?.sandboxId).toBe('sbx-1');
  });

  it('isCloudError narrows only CloudError instances', () => {
    expect(isCloudError(new CloudError('INTERNAL', 'boom'))).toBe(true);
    expect(isCloudError(new Error('plain'))).toBe(false);
    expect(isCloudError('NOT_FOUND')).toBe(false);
    expect(isCloudError(null)).toBe(false);
  });
});
