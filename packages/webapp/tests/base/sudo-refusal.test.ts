import { describe, expect, it } from 'vitest';
import { sudoRefusalMessage, timeoutNotice } from '../../src/base/sudo-refusal.js';
import * as approvalTimeout from '../../src/sudo/approval-timeout.js';

describe('base/sudo-refusal', () => {
  it('phrases a plain denial', () => {
    expect(sudoRefusalMessage('write /etc/x', { decision: 'deny' })).toBe(
      'write /etc/x: approval denied'
    );
  });

  it('phrases a timeout with its notice and appends the approver note', () => {
    const msg = sudoRefusalMessage('rm /x', {
      decision: 'deny',
      reason: 'user-timeout',
      note: ' busy ',
    });
    expect(msg).toBe(
      `rm /x: approval request timed out — ${timeoutNotice('user-timeout')} — approver's reason: busy`
    );
  });

  it('phrases an unavailable approval surface distinctly from a timeout', () => {
    expect(sudoRefusalMessage('p', { decision: 'deny', reason: 'unavailable' })).toBe(
      `p: approval could not be requested — ${timeoutNotice('unavailable')}`
    );
  });

  it('sudo/approval-timeout re-exports the same functions (#3742)', () => {
    expect(approvalTimeout.sudoRefusalMessage).toBe(sudoRefusalMessage);
    expect(approvalTimeout.timeoutNotice).toBe(timeoutNotice);
  });
});
