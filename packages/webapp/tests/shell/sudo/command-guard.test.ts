import { describe, expect, it, vi } from 'vitest';
import {
  COMMAND_DENIED_MESSAGE,
  enforceCommandSudo,
} from '../../../src/shell/sudo/command-guard.js';
import { parseSudoers } from '../../../src/shell/sudo/sudoers.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';

const GATED = parseSudoers('Cmnd  git push*\nCmnd  rm -rf *');

function brokerReturning(decision: SudoDecision): SudoBroker {
  return { requestApproval: vi.fn(async () => decision) };
}

describe('enforceCommandSudo', () => {
  it('match -> approve -> run (allows, one prompt)', async () => {
    const broker = brokerReturning({ decision: 'allow' });
    const persistGrant = vi.fn(async () => {});

    const result = await enforceCommandSudo('git push origin main', {
      policy: GATED,
      broker,
      persistGrant,
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'git push origin main',
    });
    expect(persistGrant).not.toHaveBeenCalled();
  });

  it('match -> deny -> block (no execution)', async () => {
    const broker = brokerReturning({ decision: 'deny' });

    const result = await enforceCommandSudo('rm -rf /workspace', {
      policy: GATED,
      broker,
      persistGrant: vi.fn(async () => {}),
    });

    expect(result.allowed).toBe(false);
    expect(result.message).toBe(COMMAND_DENIED_MESSAGE);
  });

  it('always -> persists the human-confirmed NOPASSWD pattern', async () => {
    const broker = brokerReturning({ decision: 'always', pattern: 'git push origin *' });
    const persistGrant = vi.fn(async () => {});

    const result = await enforceCommandSudo('git push origin main', {
      policy: GATED,
      broker,
      persistGrant,
    });

    expect(result.allowed).toBe(true);
    expect(persistGrant).toHaveBeenCalledWith('git push origin *');
  });

  it('always -> falls back to the matched segment when no pattern supplied', async () => {
    const persistGrant = vi.fn(async () => {});

    await enforceCommandSudo('git push origin main', {
      policy: GATED,
      broker: brokerReturning({ decision: 'always' }),
      persistGrant,
    });

    expect(persistGrant).toHaveBeenCalledWith('git push origin main');
  });

  it('NOPASSWD grant runs with zero prompts', async () => {
    const policy = parseSudoers('Cmnd  git push*\nNOPASSWD Cmnd  git push*');
    const broker = brokerReturning({ decision: 'deny' });

    const result = await enforceCommandSudo('git push origin main', {
      policy,
      broker,
      persistGrant: vi.fn(async () => {}),
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('ungated command runs with zero prompts', async () => {
    const broker = brokerReturning({ decision: 'deny' });

    const result = await enforceCommandSudo('ls -la', {
      policy: GATED,
      broker,
      persistGrant: vi.fn(async () => {}),
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('matches a single tokenized subject (no splitting on separators)', async () => {
    // The dispatch-time model hands one already-tokenized subject at a time; the
    // matcher does not split, so a `&&`/`|` in the subject is opaque text.
    const broker = brokerReturning({ decision: 'allow' });

    const result = await enforceCommandSudo('git push origin main', {
      policy: GATED,
      broker,
      persistGrant: vi.fn(async () => {}),
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('treats an empty subject as ungated (no prompt)', async () => {
    const broker = brokerReturning({ decision: 'deny' });

    const result = await enforceCommandSudo('   ', {
      policy: GATED,
      broker,
      persistGrant: vi.fn(async () => {}),
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('default "require-approval": unmatched command escalates and runs on allow', async () => {
    const broker = brokerReturning({ decision: 'allow' });

    // `ls` is NOT in the GATED policy — under `'allow'` default this returns
    // unprompted. Under `'require-approval'` it escalates instead of running
    // as a hard "no rule => no gate" pass.
    const result = await enforceCommandSudo('ls -la', {
      policy: GATED,
      broker,
      persistGrant: vi.fn(async () => {}),
      defaultDisposition: 'require-approval',
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
    expect(broker.requestApproval).toHaveBeenCalledWith({ kind: 'command', detail: 'ls -la' });
  });

  it('default "require-approval": NOPASSWD grant still skips the prompt', async () => {
    const policy = parseSudoers('NOPASSWD Cmnd ls*');
    const broker = brokerReturning({ decision: 'deny' });

    const result = await enforceCommandSudo('ls -la', {
      policy,
      broker,
      persistGrant: vi.fn(async () => {}),
      defaultDisposition: 'require-approval',
    });

    expect(result.allowed).toBe(true);
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('default "require-approval": deny blocks the unmatched command', async () => {
    const broker = brokerReturning({ decision: 'deny' });

    const result = await enforceCommandSudo('curl http://evil', {
      policy: GATED,
      broker,
      persistGrant: vi.fn(async () => {}),
      defaultDisposition: 'require-approval',
    });

    expect(result.allowed).toBe(false);
    expect(result.message).toBe(COMMAND_DENIED_MESSAGE);
  });
});
