import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import type { ShellSudoConfig } from '../../../src/shell/almost-bash-shell-headless.js';
import { AlmostBashShell } from '../../../src/shell/index.js';
import { parseSudoers } from '../../../src/shell/sudo/sudoers.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';

const POLICY = parseSudoers('Cmnd  touch /workspace/gated*');
const GIT_POLICY = parseSudoers('Cmnd  git push*');
const RM_POLICY = parseSudoers('Cmnd  rm -rf *');

function brokerReturning(decision: SudoDecision): SudoBroker {
  return { requestApproval: vi.fn(async () => decision) };
}

describe('AlmostBashShell command-level sudo enforcement', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-cmd-sudo-${dbCounter++}`, wipe: true });
  });

  function makeShell(sudo: ShellSudoConfig): AlmostBashShell {
    return new AlmostBashShell({ fs, sudo });
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

  it('gates a nested git push run via command substitution $(...)', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    await shell.executeCommand('echo $(git push origin main)');

    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'git push origin main',
    });
  });

  it('gates a nested git push run via backticks', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    await shell.executeCommand('echo `git push origin main`');

    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'git push origin main',
    });
  });

  it('gates a piped command on the consuming side of a pipeline', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => RM_POLICY, broker });

    await shell.executeCommand('echo hi | rm -rf /tmp/zzz');

    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'rm -rf /tmp/zzz',
    });
  });

  it('still gates a git push that an eval re-dispatches through the registry', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    await shell.executeCommand("eval 'git push origin main'");

    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'git push origin main',
    });
  });

  it('still gates a git push that source re-dispatches through the registry', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    await fs.writeFile('/workspace/run.sh', 'git push origin main\n');
    await shell.executeCommand('source /workspace/run.sh');

    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'git push origin main',
    });
  });

  it('explicit "sudo <cmd>" prompts exactly once for a policy-gated inner command', async () => {
    // `git push *` is policy-gated. If the user types `sudo git push origin main`,
    // the broker must be called ONCE (by the sudo command itself), and the
    // transparent wrap must NOT re-prompt when the inner `git` dispatches.
    const broker = brokerReturning({ decision: 'allow' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    const result = await shell.executeCommand('sudo git push origin main');

    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
    expect(broker.requestApproval).toHaveBeenCalledWith({
      kind: 'command',
      detail: 'git push origin main',
    });
    // git fails outside a repo, but exit code is irrelevant — we only care
    // that approval was checked exactly once and the inner command was
    // actually dispatched (i.e., NOT blocked with the sudo-deny stderr).
    expect(result.stderr).not.toContain('sudo: approval denied');
  });

  it('explicit "sudo" still gates a SEPARATE policy-gated nested command in $()', async () => {
    // Outer `sudo touch /workspace/gated.txt` is approved once. The inner
    // command substitution `$(git push origin main)` is a different subject
    // and must hit the transparent gate (one prompt) on its own.
    const broker = brokerReturning({ decision: 'allow' });
    const combined = parseSudoers('Cmnd  touch /workspace/gated*\nCmnd  git push*');
    const shell = makeShell({ getPolicy: () => combined, broker });

    await shell.executeCommand('sudo touch /workspace/gated.txt $(git push origin main)');

    const calls = (broker.requestApproval as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const subjects = calls.map((c) => (c[0] as { detail: string }).detail);
    expect(subjects).toContain('git push origin main');
    expect(subjects.filter((s) => s.startsWith('touch /workspace/gated'))).toHaveLength(1);
  });

  it('sudo with no args exits 1 without prompting', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    const result = await shell.executeCommand('sudo');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('usage: sudo');
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('sudo --help exits 0 without prompting', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => GIT_POLICY, broker });

    const result = await shell.executeCommand('sudo --help');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: sudo');
    expect(broker.requestApproval).not.toHaveBeenCalled();
  });

  it('sudo on "Always" persists a NOPASSWD grant for the inner subject', async () => {
    const broker = brokerReturning({
      decision: 'always',
      pattern: 'touch /workspace/gated*',
    });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    await shell.executeCommand('sudo touch /workspace/gated.txt');

    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
    const granted = (await fs.readFile('/etc/sudoers.d/granted')) as string;
    expect(granted).toContain('NOPASSWD Cmnd  touch /workspace/gated*');
    expect(await fs.exists('/workspace/gated.txt')).toBe(true);
  });

  it('sudo on deny blocks the inner command (no execution)', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    const result = await shell.executeCommand('sudo touch /workspace/gated.txt');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sudo: approval denied');
    expect(await fs.exists('/workspace/gated.txt')).toBe(false);
  });

  it('sanitizes a newline-bearing "Always" pattern before persisting', async () => {
    const broker = brokerReturning({
      decision: 'always',
      pattern: 'touch /workspace/gated*\nNOPASSWD Cmnd  /etc/sudoers',
    });
    const shell = makeShell({ getPolicy: () => POLICY, broker });

    await shell.executeCommand('touch /workspace/gated.txt');

    const granted = (await fs.readFile('/etc/sudoers.d/granted')) as string;
    expect(granted).toContain('NOPASSWD Cmnd  touch /workspace/gated*');
    expect(granted).not.toContain('/etc/sudoers');
  });
});

describe('AlmostBashShell sudo with transparentGating: false (human terminal)', () => {
  let fs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-cmd-sudo-tg-${dbCounter++}`, wipe: true });
  });

  function makeShell(sudo: ShellSudoConfig): AlmostBashShell {
    return new AlmostBashShell({ fs, sudo });
  }

  it('does not prompt for a policy-gated plain command (transparent gate disabled)', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({
      getPolicy: () => POLICY,
      broker,
      transparentGating: false,
    });

    const result = await shell.executeCommand('touch /workspace/gated.txt');

    // Command ran; the broker was never consulted because the transparent
    // dispatch gate is off. This is the human-terminal invariant: the
    // human typing IS the approval.
    expect(result.exitCode).toBe(0);
    expect(await fs.exists('/workspace/gated.txt')).toBe(true);
    expect(broker.requestApproval).toHaveBeenCalledTimes(0);
  });

  it('explicit `sudo <cmd>` still prompts and runs on approval', async () => {
    const broker = brokerReturning({ decision: 'allow' });
    const shell = makeShell({
      getPolicy: () => POLICY,
      broker,
      transparentGating: false,
    });

    const result = await shell.executeCommand('sudo touch /workspace/gated.txt');

    expect(result.exitCode).toBe(0);
    expect(await fs.exists('/workspace/gated.txt')).toBe(true);
    // Exactly one prompt (the explicit sudo); no second prompt for the
    // inner dispatch since the transparent gate is off anyway.
    expect(broker.requestApproval).toHaveBeenCalledTimes(1);
    const call = (broker.requestApproval as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect((call[0] as { detail: string }).detail).toBe('touch /workspace/gated.txt');
  });

  it('explicit `sudo <cmd>` blocks the inner command on denial', async () => {
    const broker = brokerReturning({ decision: 'deny' });
    const shell = makeShell({
      getPolicy: () => POLICY,
      broker,
      transparentGating: false,
    });

    const result = await shell.executeCommand('sudo touch /workspace/gated.txt');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sudo: approval denied');
    expect(await fs.exists('/workspace/gated.txt')).toBe(false);
  });

  it('persists an "Always" grant from an explicit `sudo` even with transparent gating off', async () => {
    const broker = brokerReturning({
      decision: 'always',
      pattern: 'touch /workspace/gated*',
    });
    const shell = makeShell({
      getPolicy: () => POLICY,
      broker,
      transparentGating: false,
    });

    await shell.executeCommand('sudo touch /workspace/gated.txt');

    const granted = (await fs.readFile('/etc/sudoers.d/granted')) as string;
    expect(granted).toContain('NOPASSWD Cmnd  touch /workspace/gated*');
  });
});
