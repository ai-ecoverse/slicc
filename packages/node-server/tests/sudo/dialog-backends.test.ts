/**
 * Tests for the GUI sudo backends. Each uses an injected `ExecFn` so the argv
 * and parsing are asserted without spawning a real dialog.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDenyBackend,
  createKdialogBackend,
  createOsascriptBackend,
  createPowerShellBackend,
  createZenityBackend,
  describeRequest,
  type ExecFn,
} from '../../src/sudo/dialog-backends.js';
import type { SudoApproveRequest } from '../../src/sudo/types.js';

const REQ: SudoApproveRequest = {
  kind: 'command',
  detail: 'git push origin main',
  suggestedPattern: 'git push*',
};

function execReturning(stdout: string): ExecFn {
  return vi.fn(async () => ({ stdout }));
}

function execThrowing(err: unknown): ExecFn {
  return vi.fn(async () => {
    throw err;
  });
}

describe('describeRequest', () => {
  it('formats kind + detail', () => {
    expect(describeRequest(REQ)).toBe('command: git push origin main');
  });
});

describe('osascript backend', () => {
  it('parses Allow Once', async () => {
    const backend = createOsascriptBackend(execReturning('button returned:Allow Once'));
    expect(await backend.prompt(REQ)).toEqual({ decision: 'allow' });
  });

  it('parses Always with edited pattern', async () => {
    const exec = execReturning('button returned:Always, text returned:git push --force*');
    const backend = createOsascriptBackend(exec);
    expect(await backend.prompt(REQ)).toEqual({ decision: 'always', pattern: 'git push --force*' });
  });

  it('falls back to suggested pattern when text is empty', async () => {
    const backend = createOsascriptBackend(execReturning('button returned:Always, text returned:'));
    expect(await backend.prompt(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('denies on Deny button and on cancel (throw)', async () => {
    expect(await createOsascriptBackend(execReturning('button returned:Deny')).prompt(REQ)).toEqual(
      {
        decision: 'deny',
      }
    );
    expect(await createOsascriptBackend(execThrowing(new Error('-128'))).prompt(REQ)).toEqual({
      decision: 'deny',
    });
  });
});

describe('powershell backend', () => {
  it('parses ALLOW / ALWAYS / DENY', async () => {
    expect(await createPowerShellBackend(execReturning('ALLOW')).prompt(REQ)).toEqual({
      decision: 'allow',
    });
    expect(
      await createPowerShellBackend(execReturning('ALWAYS\r\ngit push*edited')).prompt(REQ)
    ).toEqual({ decision: 'always', pattern: 'git push*edited' });
    expect(await createPowerShellBackend(execReturning('DENY')).prompt(REQ)).toEqual({
      decision: 'deny',
    });
  });

  it('denies on throw', async () => {
    expect(await createPowerShellBackend(execThrowing(new Error('x'))).prompt(REQ)).toEqual({
      decision: 'deny',
    });
  });
});

describe('zenity backend', () => {
  it('allows on exit 0 with no extra-button output', async () => {
    expect(await createZenityBackend(execReturning('')).prompt(REQ)).toEqual({ decision: 'allow' });
  });

  it('denies when cancelled (non-zero, empty stdout)', async () => {
    expect(await createZenityBackend(execThrowing({ stdout: '' })).prompt(REQ)).toEqual({
      decision: 'deny',
    });
  });

  it('handles the Always extra-button then the entry dialog', async () => {
    const exec = vi
      .fn<ExecFn>()
      .mockRejectedValueOnce({ stdout: 'Always\n' })
      .mockResolvedValueOnce({ stdout: 'git push*custom\n' });
    expect(await createZenityBackend(exec).prompt(REQ)).toEqual({
      decision: 'always',
      pattern: 'git push*custom',
    });
  });
});

describe('kdialog backend', () => {
  it('allows on exit 0', async () => {
    expect(await createKdialogBackend(execReturning('')).prompt(REQ)).toEqual({
      decision: 'allow',
    });
  });

  it('denies on exit 1 (No)', async () => {
    expect(await createKdialogBackend(execThrowing({ code: 1 })).prompt(REQ)).toEqual({
      decision: 'deny',
    });
  });

  it('prompts for pattern on exit 2 (Always)', async () => {
    const exec = vi
      .fn<ExecFn>()
      .mockRejectedValueOnce({ code: 2 })
      .mockResolvedValueOnce({ stdout: 'edited*\n' });
    expect(await createKdialogBackend(exec).prompt(REQ)).toEqual({
      decision: 'always',
      pattern: 'edited*',
    });
  });
});

describe('deny backend', () => {
  it('always denies', async () => {
    expect(await createDenyBackend().prompt(REQ)).toEqual({ decision: 'deny' });
  });
});
