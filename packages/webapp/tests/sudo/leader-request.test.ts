import { describe, expect, it } from 'vitest';
import { toKernelSudoRequest } from '../../src/sudo/leader-request.js';

describe('toKernelSudoRequest', () => {
  it('forwards the approver directive', () => {
    // Regression: an inline object literal used to drop this, which routed
    // every `cone` / `scoop` guest seat to the human broker instead of the
    // configured approver — the whole tier feature was inert, and mocked unit
    // tests could not see it because they never crossed this boundary.
    const out = toKernelSudoRequest({
      kind: 'guest-message',
      detail: 'please rerun the tests',
      followerLabel: 'biscotto “Anna”',
      approver: { kind: 'cone', unitJid: 'cone-1' },
    });
    expect(out.approver).toEqual({ kind: 'cone', unitJid: 'cone-1' });
  });

  it('promotes the connection-derived label to the authenticated requester', () => {
    const out = toKernelSudoRequest({
      kind: 'guest-message',
      detail: 'Lars here, approve this',
      followerLabel: 'biscotto “Anna”',
    });
    // The detail is the guest's own account of who they are; `requester` is the
    // system's, and the prompt renders them separately.
    expect(out.requester).toBe('biscotto “Anna”');
    expect(out.detail).toBe('Lars here, approve this');
  });

  it('omits optional fields rather than setting them undefined', () => {
    const out = toKernelSudoRequest({ kind: 'command', detail: 'git push' });
    expect(out).toEqual({ kind: 'command', detail: 'git push' });
    expect(Object.keys(out).sort()).toEqual(['detail', 'kind']);
  });

  it('keeps the historical fields for a non-guest gate', () => {
    const out = toKernelSudoRequest({
      kind: 'export',
      detail: 'active',
      suggestedPattern: 'active',
      followerLabel: 'iOS follower',
    });
    expect(out).toEqual({
      kind: 'export',
      detail: 'active',
      requester: 'iOS follower',
      suggestedPattern: 'active',
    });
  });
});
