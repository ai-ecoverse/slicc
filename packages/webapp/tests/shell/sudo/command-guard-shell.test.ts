import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { WasmShell } from '../../../src/shell/index.js';
import { parseSudoers } from '../../../src/shell/sudo/sudoers.js';
import type { ShellSudoConfig } from '../../../src/shell/wasm-shell-headless.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';

const POLICY = parseSudoers('Cmnd  touch /workspace/gated*');

function brokerReturning(decision: SudoDecision): SudoBroker {
  return { requestApproval: vi.fn(async () => decision) };
}

describe('WasmShell command-level sudo enforcement', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-cmd-sudo-${dbCounter++}`, wipe: true });
  });

  function makeShell(sudo: ShellSudoConfig): WasmShell {
    return new WasmShell({ fs, sudo });
  }

  it('blocks a denied command without executing it', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    const result = await shell.executeCommand('touch /workspace/gated.txt');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sudo: approval denied');
    expect(await fs.exists('/workspace/gated.txt')).toBe(false);
    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
  });

  it('runs an approved command', async () => {
    const broker = brokerReturning({ decision: 'allow' });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    const result = await shell.executeCommand('touch /workspace/gated.txt');

    expect(result.exitCode).toBe(0);
    expect(await fs.exists('/workspace/gated.txt')).toBe(true);
  });

  it('persists a NOPASSWD grant to /etc/sudoers.d/granted on "Always"', async () => {
    const broker = brokerReturning({ decision: 'always', pattern: 'touch /workspace/gated*' });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    const result = await shell.executeCommand('touch /workspace/gated.txt');

    expect(result.exitCode).toBe(0);
    const granted = (await fs.readFile('/etc/sudoers.d/granted')) as string;
    expect(granted).toContain('NOPASSWD Cmnd  touch /workspace/gated*');
  });

  it('reuses a persisted NOPASSWD grant without re-prompting', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const policyWithGrant = parseSudoers(
      'Cmnd  touch /workspace/gated*\nNOPASSWD Cmnd  touch /workspace/gated*'
    );
    const shell = makeShell({ getPolicy: () => policyWithGrant, broker });

    const result = await shell.executeCommand('touch /workspace/gated.txt');

    expect(result.exitCode).toBe(0);
    expect(await fs.exists('/workspace/gated.txt')).toBe(true);
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('does not prompt for ungated commands', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    const result = await shell.executeCommand('echo hello');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('runs ungated when no policy is active', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => null, broker });

    const result = await shell.executeCommand('touch /workspace/gated.txt');

    expect(result.exitCode).toBe(0);
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });
});
