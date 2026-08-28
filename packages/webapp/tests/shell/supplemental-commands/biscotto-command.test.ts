import { describe, expect, it } from 'vitest';
import {
  parseApprover,
  parseDuration,
  parseServeArgs,
} from '../../../src/shell/supplemental-commands/biscotto/run.js';

describe('parseDuration', () => {
  it('reads the suffixed forms', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('reads a bare number as seconds', () => {
    expect(parseDuration('45')).toBe(45_000);
  });

  it('rejects anything it cannot read rather than guessing', () => {
    for (const bad of ['', 'soon', '-5m', '0', '1w', '3.5h', '10 m s']) {
      expect(parseDuration(bad), bad).toBeNull();
    }
  });
});

describe('parseApprover', () => {
  it('reads the simple tiers', () => {
    expect(parseApprover('user')).toEqual({ approver: 'user' });
    expect(parseApprover('cone')).toEqual({ approver: 'cone' });
    expect(parseApprover('agent')).toEqual({ approver: 'agent' });
    expect(parseApprover('off')).toEqual({ approver: 'off' });
  });

  it('reads a named scoop', () => {
    expect(parseApprover('scoop:reviewer')).toEqual({ approver: 'scoop', scoop: 'reviewer' });
  });

  it('rejects an unrecognised tier instead of defaulting', () => {
    // An approver nobody recognises must not quietly become a different one.
    for (const bad of ['', 'scoop:', 'nobody', 'USER', 'scoop']) {
      expect(parseApprover(bad), bad).toBeNull();
    }
  });
});

describe('parseServeArgs', () => {
  it('requires a label — the seat has to say who it is for', () => {
    expect(parseServeArgs([])).toBe('--label is required: say who the seat is for');
  });

  it('defaults both gates to the owner', () => {
    expect(parseServeArgs(['--label', 'Anna'])).toEqual({
      label: 'Anna',
      ttlMs: undefined,
      gates: { message: { approver: 'user' }, tool: { approver: 'user' } },
    });
  });

  it('accepts a full configuration', () => {
    expect(
      parseServeArgs([
        '--label',
        'Anna',
        '--expires',
        '7d',
        '--gate-messages',
        'cone',
        '--gate-tools',
        'scoop:reviewer',
      ])
    ).toEqual({
      label: 'Anna',
      ttlMs: 604_800_000,
      gates: {
        message: { approver: 'cone' },
        tool: { approver: 'scoop', scoop: 'reviewer' },
      },
    });
  });

  it('refuses a cone tool gate at configuration time', () => {
    // Otherwise it is only discovered as a five-minute stalled approval: the
    // cone is the unit executing the tool it would be asked to approve.
    const result = parseServeArgs(['--label', 'Anna', '--gate-tools', 'cone']);
    expect(result).toContain('cannot approve a tool call it is blocked on');
  });

  it('allows an agent TOOL gate — the approver is not the unit being blocked', () => {
    // Unlike `cone`, an approver agent is a separate bounded run, so it can
    // decide a tool call without waiting on the tool it is deciding.
    expect(parseServeArgs(['--label', 'Anna', '--gate-tools', 'agent'])).toMatchObject({
      gates: { tool: { approver: 'agent' } },
    });
  });

  it('still allows a cone MESSAGE gate — nothing is running when it asks', () => {
    const result = parseServeArgs(['--label', 'Anna', '--gate-messages', 'cone']);
    expect(typeof result).not.toBe('string');
  });

  it('caps the lifetime', () => {
    expect(parseServeArgs(['--label', 'Anna', '--expires', '31d'])).toBe(
      '--expires cannot exceed 30d'
    );
  });

  it('reports an unknown option instead of ignoring it', () => {
    expect(parseServeArgs(['--label', 'Anna', '--public'])).toBe('unknown option: --public');
  });

  it('reports a flag missing its value', () => {
    expect(parseServeArgs(['--label'])).toBe('--label needs a name');
    expect(parseServeArgs(['--label', 'A', '--expires'])).toBe(
      '--expires needs a duration (30m, 12h, 7d)'
    );
  });
});
