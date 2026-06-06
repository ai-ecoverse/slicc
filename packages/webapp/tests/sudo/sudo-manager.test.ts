/**
 * Tests for `SudoManager` — the live sudoers policy store.
 *
 * Covers default-template seeding on a fresh VFS, merge of `/etc/sudoers` +
 * `/etc/sudoers.d/*`, live reload via the `FsWatcher` when those files change,
 * the command-grant sink (used by the shell on "Always"), and watcher teardown.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../src/fs/index.js';
import { matchCommand, SUDOERS_FILE } from '../../src/shell/sudo/sudoers.js';
import { SudoManager } from '../../src/sudo/sudo-manager.js';
import type { SudoBroker } from '../../src/sudo/types.js';

const broker: SudoBroker = { requestApproval: vi.fn(async () => ({ decision: 'deny' as const })) };

async function flush(check: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !check(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('SudoManager', () => {
  let vfs: VirtualFS;
  let watcher: FsWatcher;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-sudo-mgr-${dbCounter++}`, wipe: true });
    watcher = new FsWatcher();
    vfs.setWatcher(watcher);
  });
  afterEach(() => {
    vfs.dispose?.();
  });

  it('seeds the default /etc/sudoers template and gates nothing by default', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    const seeded = (await vfs.readFile(SUDOERS_FILE, { encoding: 'utf-8' })) as string;
    expect(seeded).toContain('SLICC agent approval policy');
    // Every rule in the template is commented out → no active command gating.
    expect(matchCommand(mgr.getPolicy(), 'git push origin main')).toBe('no-match');
    mgr.dispose();
  });

  it('does not overwrite an existing /etc/sudoers', async () => {
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.writeFile(SUDOERS_FILE, 'Cmnd  git push*\n');
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    expect((await vfs.readFile(SUDOERS_FILE, { encoding: 'utf-8' })) as string).toBe(
      'Cmnd  git push*\n'
    );
    expect(matchCommand(mgr.getPolicy(), 'git push origin main')).toBe('require-approval');
    mgr.dispose();
  });

  it('merges /etc/sudoers with /etc/sudoers.d/* drop-ins', async () => {
    await vfs.mkdir('/etc/sudoers.d', { recursive: true });
    await vfs.writeFile(SUDOERS_FILE, 'Cmnd  git push*\n');
    await vfs.writeFile('/etc/sudoers.d/granted', 'NOPASSWD Cmnd  git push origin*\n');
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    // The NOPASSWD drop-in grant wins over the plain Cmnd rule.
    expect(matchCommand(mgr.getPolicy(), 'git push origin main')).toBe('nopasswd-allow');
    // A push that the grant does not cover still requires approval.
    expect(matchCommand(mgr.getPolicy(), 'git push upstream main')).toBe('require-approval');
    mgr.dispose();
  });

  it('live-reloads when /etc/sudoers changes via the watcher', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    expect(matchCommand(mgr.getPolicy(), 'rm -rf /workspace')).toBe('no-match');

    // Edit the config out-of-band (write goes through the watched VFS).
    await vfs.writeFile(SUDOERS_FILE, 'Cmnd  rm -rf *\n');
    await flush(() => matchCommand(mgr.getPolicy(), 'rm -rf /workspace') === 'require-approval');

    expect(matchCommand(mgr.getPolicy(), 'rm -rf /workspace')).toBe('require-approval');
    mgr.dispose();
  });

  it('persistCommandGrant appends a NOPASSWD Cmnd rule and reloads it active', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    const sink = mgr.getShellConfig().persistCommandGrant;
    expect(sink).toBeTypeOf('function');

    await sink?.('rm -rf *');

    const granted = (await vfs.readFile('/etc/sudoers.d/granted', { encoding: 'utf-8' })) as string;
    expect(granted).toContain('NOPASSWD Cmnd  rm -rf *');
    expect(matchCommand(mgr.getPolicy(), 'rm -rf /tmp/x')).toBe('nopasswd-allow');
    mgr.dispose();
  });

  it('persistCommandGrant sanitizes a newline-bearing pattern before writing', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    const sink = mgr.getShellConfig().persistCommandGrant;

    await sink?.('rm -rf *\nNOPASSWD Cmnd  /etc/sudoers');

    const granted = (await vfs.readFile('/etc/sudoers.d/granted', { encoding: 'utf-8' })) as string;
    // Only the first trimmed line is persisted — no injected second rule.
    expect(granted).toContain('NOPASSWD Cmnd  rm -rf *');
    expect(granted).not.toContain('/etc/sudoers');
    mgr.dispose();
  });

  it('getShellConfig() defaults transparentGating to true (agent shell)', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    expect(mgr.getShellConfig().transparentGating).toBe(true);
    expect(mgr.getShellConfig({}).transparentGating).toBe(true);
    mgr.dispose();
  });

  it('getShellConfig({ transparentGating: false }) propagates the flag (human terminal)', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    const cfg = mgr.getShellConfig({ transparentGating: false });
    expect(cfg.transparentGating).toBe(false);
    // Broker + persist sink are still wired — the explicit `sudo` command
    // depends on them.
    expect(cfg.broker).toBe(mgr.getBroker());
    expect(cfg.persistCommandGrant).toBeTypeOf('function');
    mgr.dispose();
  });

  it('stops reacting to changes after dispose()', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    mgr.dispose();

    await vfs.writeFile(SUDOERS_FILE, 'Cmnd  rm -rf *\n');
    await new Promise((r) => setTimeout(r, 10));
    // No watcher reload happened, so the policy is still the seeded (empty) one.
    expect(matchCommand(mgr.getPolicy(), 'rm -rf /workspace')).toBe('no-match');
  });
});
