/**
 * `git-credential-slicc` is git's plumbing: native git runs it for every
 * authenticated request, as a shell command. So `git`'s command policy is its
 * policy — available exactly when `git` is, and never a second approval.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSudoers } from '../../src/base/sudoers.js';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import type { SudoBroker } from '../../src/sudo/types.js';

let fs: VirtualFS;
let n = 0;

beforeEach(async () => {
  fs = await VirtualFS.create({ dbName: `git-credential-policy-${n++}`, wipe: true });
});

describe('git-credential-slicc follows git’s command policy', () => {
  it('is available in a scoop whose allowedCommands name git', async () => {
    const shell = new AlmostBashShellHeadless({ fs, allowedCommands: ['git', 'echo'] });
    const r = await shell.executeCommand('git-credential-slicc --help');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('usage: git-credential-slicc');
  });

  it('is unavailable in a scoop whose allowedCommands leave git out', async () => {
    const shell = new AlmostBashShellHeadless({ fs, allowedCommands: ['echo'] });
    const r = await shell.executeCommand('git-credential-slicc --help');
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toMatch(/not found/i);
  });

  it('never asks for its own approval under a sudo Cmnd policy', async () => {
    const broker: SudoBroker = {
      requestApproval: vi.fn(async () => ({ decision: 'deny' as const })),
    };
    // Every command needs approval here, git's included.
    const shell = new AlmostBashShellHeadless({
      fs,
      sudo: {
        getPolicy: () => parseSudoers('Cmnd  git *'),
        broker,
        defaultDisposition: 'require-approval',
      },
    });
    const helper = await shell.executeCommand(
      "printf 'protocol=https\\nhost=evil.example\\n\\n' | git-credential-slicc get"
    );
    expect(helper.exitCode, helper.stderr).toBe(0);
    expect(helper.stdout).toBe(''); // nothing for a host no credential covers
    expect(broker.requestApproval).not.toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('git-credential-slicc') })
    );
    // git itself is still gated.
    const git = await shell.executeCommand('git status');
    expect(git.exitCode).toBe(77);
    expect(broker.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'command', detail: 'git status' })
    );
  });
});
