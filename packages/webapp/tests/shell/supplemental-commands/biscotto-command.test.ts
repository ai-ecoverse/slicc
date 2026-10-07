import { describe, expect, it } from 'vitest';
import {
  parseApprover,
  parseDuration,
  parseServeArgs,
  runBiscotto,
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
    const result = parseServeArgs(['--label', 'Anna', '--gate-tools', 'cone']);
    expect(result).toContain('cannot approve a tool call it is blocked on');
  });

  it('allows an agent TOOL gate — the approver is not the unit being blocked', () => {
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
    expect(parseServeArgs(['--label', 'A', '--gate-tools'])).toBe(
      '--gate-tools needs an approver (user, cone, agent, scoop:<name>, off)'
    );
  });
});

describe('runBiscotto serve binds the seat to the unit that ran it', () => {
  const g = globalThis as unknown as { __slicc_panelRpc?: unknown };

  function withRpc() {
    const calls: Array<{ op: string; payload: unknown }> = [];
    g.__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        return {
          id: 'seat1',
          url: 'https://www.sliccy.ai/join/x',
          label: 'Anna',
          gates: { message: { approver: 'user' }, tool: { approver: 'user' } },
        };
      },
    };
    return calls;
  }

  it('sends the calling unit with the mint', async () => {
    const calls = withRpc();
    try {
      const result = await runBiscotto(
        'biscotto',
        ['serve', '--label', 'Anna'],
        {} as never,
        'cone_helix'
      );
      expect(result.exitCode).toBe(0);
      expect(calls[0]?.op).toBe('tray-mint-biscotto');
      expect(calls[0]?.payload).toMatchObject({ label: 'Anna', unitJid: 'cone_helix' });
    } finally {
      delete g.__slicc_panelRpc;
    }
  });

  it('refuses to mint from a scoop, and never reaches the leader', async () => {
    const calls = withRpc();
    try {
      const result = await runBiscotto(
        'biscotto',
        ['serve', '--label', 'Anna'],
        {} as never,
        'scoop_reviewer',
        true
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot be minted from a scoop');
      expect(calls).toHaveLength(0);
    } finally {
      delete g.__slicc_panelRpc;
    }
  });

  it('refuses to mint from a shell that belongs to no unit, rather than guessing one', async () => {
    const calls = withRpc();
    try {
      const result = await runBiscotto('biscotto', ['serve', '--label', 'Anna'], {} as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('which conversation to share');
      expect(calls).toHaveLength(0);
    } finally {
      delete g.__slicc_panelRpc;
    }
  });
});
