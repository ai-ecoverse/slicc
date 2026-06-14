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
import {
  matchCommand,
  matchPath,
  SUDOERS_FILE,
  scoopSudoersPath,
} from '../../src/shell/sudo/sudoers.js';
import { generateScoopSudoers, SudoManager } from '../../src/sudo/sudo-manager.js';
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

describe('generateScoopSudoers', () => {
  it('emits NOPASSWD Cmnd * when allowedCommands is omitted (unrestricted)', () => {
    const text = generateScoopSudoers(undefined);
    expect(text).toContain('NOPASSWD Cmnd *');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('emits NOPASSWD Cmnd * when allowedCommands contains "*"', () => {
    const text = generateScoopSudoers({ allowedCommands: ['git', '*', 'ls'] });
    // The wildcard short-circuits — per-command grants are NOT emitted alongside it.
    expect(text).toContain('NOPASSWD Cmnd *');
    expect(text).not.toContain('NOPASSWD Cmnd git*');
    expect(text).not.toContain('NOPASSWD Cmnd ls*');
  });

  it('emits NOPASSWD Cmnd <c>* per allowed command', () => {
    const text = generateScoopSudoers({ allowedCommands: ['git', 'ls'] });
    expect(text).toContain('NOPASSWD Cmnd git*');
    expect(text).toContain('NOPASSWD Cmnd ls*');
    // No unrestricted wildcard when an explicit list is provided.
    expect(text).not.toMatch(/^NOPASSWD Cmnd \*$/m);
  });

  it('emits no Cmnd grants for an explicit empty allowedCommands list', () => {
    const text = generateScoopSudoers({ allowedCommands: [] });
    expect(text).not.toMatch(/^NOPASSWD Cmnd /m);
  });

  it('emits NOPASSWD Write <p>/** per writablePath, trimming trailing slash', () => {
    const text = generateScoopSudoers({
      writablePaths: ['/scoops/foo/', '/shared'],
    });
    expect(text).toContain('NOPASSWD Write /scoops/foo/**');
    expect(text).toContain('NOPASSWD Write /shared/**');
  });

  it('emits NOPASSWD Read <p>/** per visiblePath', () => {
    const text = generateScoopSudoers({ visiblePaths: ['/workspace/', '/shared'] });
    expect(text).toContain('NOPASSWD Read /workspace/**');
    expect(text).toContain('NOPASSWD Read /shared/**');
  });

  it('sanitizes newline-bearing entries via sanitizeGrantPattern (no rule injection)', () => {
    const text = generateScoopSudoers({
      allowedCommands: ['git\nNOPASSWD Cmnd  /etc/sudoers'],
      writablePaths: ['/scoops/foo\nNOPASSWD Write /etc/sudoers'],
      visiblePaths: ['/workspace\nNOPASSWD Read /etc/sudoers'],
    });
    // Only the first trimmed line of each entry survives.
    expect(text).toContain('NOPASSWD Cmnd git*');
    expect(text).toContain('NOPASSWD Write /scoops/foo/**');
    expect(text).toContain('NOPASSWD Read /workspace/**');
    // The injection attempts must NOT appear as standalone rules.
    expect(text).not.toContain('/etc/sudoers');
  });

  it('produces a full sandbox surface for a typical scoop config', () => {
    const text = generateScoopSudoers({
      writablePaths: ['/scoops/andy', '/shared'],
      visiblePaths: ['/workspace'],
      allowedCommands: ['git', 'ls', 'cat'],
    });
    expect(text).toContain('NOPASSWD Cmnd git*');
    expect(text).toContain('NOPASSWD Cmnd ls*');
    expect(text).toContain('NOPASSWD Cmnd cat*');
    expect(text).toContain('NOPASSWD Write /scoops/andy/**');
    expect(text).toContain('NOPASSWD Write /shared/**');
    expect(text).toContain('NOPASSWD Read /workspace/**');
  });
});

describe('SudoManager per-scoop policy view', () => {
  let vfs: VirtualFS;
  let watcher: FsWatcher;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-sudo-mgr-scoop-${dbCounter++}`, wipe: true });
    watcher = new FsWatcher();
    vfs.setWatcher(watcher);
  });
  afterEach(() => {
    vfs.dispose?.();
  });

  it('getPolicyForScoop returns the global policy when no scoop file has been seeded', async () => {
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.writeFile(SUDOERS_FILE, 'Cmnd  rm -rf *\n');
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    const policy = mgr.getPolicyForScoop('andy');
    expect(matchCommand(policy, 'rm -rf /tmp')).toBe('require-approval');
    expect(matchCommand(policy, 'ls')).toBe('no-match');
    mgr.dispose();
  });

  it('seedScoopSudoers writes the generated body to /scoops/<folder>/etc/sudoers', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    await mgr.seedScoopSudoers('andy', {
      writablePaths: ['/scoops/andy'],
      visiblePaths: ['/workspace'],
      allowedCommands: ['git'],
    });

    const written = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;
    expect(written).toContain('NOPASSWD Cmnd git*');
    expect(written).toContain('NOPASSWD Write /scoops/andy/**');
    expect(written).toContain('NOPASSWD Read /workspace/**');
    mgr.dispose();
  });

  it('getPolicyForScoop merges global rules with the scoop-local NOPASSWD grants', async () => {
    await vfs.mkdir('/etc', { recursive: true });
    // Global config gates `git push*`.
    await vfs.writeFile(SUDOERS_FILE, 'Cmnd  git push*\n');
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    await mgr.seedScoopSudoers('andy', {
      writablePaths: ['/scoops/andy'],
      // Scoop is explicitly allowed `git`, which (as `git*`) covers `git push`.
      allowedCommands: ['git'],
    });

    const scoopPolicy = mgr.getPolicyForScoop('andy');
    // The scoop-local NOPASSWD grant wins over the global require-approval rule.
    expect(matchCommand(scoopPolicy, 'git push origin main')).toBe('nopasswd-allow');
    expect(matchPath(scoopPolicy, 'write', '/scoops/andy/workspace/file.txt')).toBe(
      'nopasswd-allow'
    );

    // The cone view is unchanged — global only.
    expect(matchCommand(mgr.getPolicy(), 'git push origin main')).toBe('require-approval');
    mgr.dispose();
  });

  it("does not bleed one scoop's grants into another scoop's policy view", async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    await mgr.seedScoopSudoers('andy', {
      writablePaths: ['/scoops/andy'],
      allowedCommands: ['git'],
    });
    await mgr.seedScoopSudoers('beth', {
      writablePaths: ['/scoops/beth'],
      allowedCommands: ['ls'],
    });

    const andy = mgr.getPolicyForScoop('andy');
    const beth = mgr.getPolicyForScoop('beth');
    expect(matchCommand(andy, 'git status')).toBe('nopasswd-allow');
    expect(matchCommand(andy, 'ls')).toBe('no-match');
    expect(matchCommand(beth, 'ls -la')).toBe('nopasswd-allow');
    expect(matchCommand(beth, 'git status')).toBe('no-match');
    mgr.dispose();
  });

  it('live-reloads a scoop policy when its sudoers file changes via the watcher', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    await mgr.seedScoopSudoers('andy', { allowedCommands: ['git'] });
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'ls')).toBe('no-match');

    // Edit the scoop's policy out-of-band — should pick up via the watcher.
    await vfs.writeFile(scoopSudoersPath('andy'), 'NOPASSWD Cmnd ls*\n');
    await flush(() => matchCommand(mgr.getPolicyForScoop('andy'), 'ls -la') === 'nopasswd-allow');
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'ls -la')).toBe('nopasswd-allow');
    mgr.dispose();
  });

  it('drops a scoop policy from the cache when its sudoers file is removed', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    await mgr.seedScoopSudoers('andy', { allowedCommands: ['git'] });
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git status')).toBe('nopasswd-allow');

    await vfs.rm(scoopSudoersPath('andy'), { recursive: false });
    await flush(() => matchCommand(mgr.getPolicyForScoop('andy'), 'git status') === 'no-match');
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git status')).toBe('no-match');
    mgr.dispose();
  });

  it('writes to /scoops/<folder>/etc/sudoers via the raw fs are not self-gated (seed path)', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    // No throw — the SudoManager owns the raw VFS, the self-protection invariant
    // only fires through `createSudoFs`.
    await expect(
      mgr.seedScoopSudoers('andy', { allowedCommands: ['git'] })
    ).resolves.toBeUndefined();
    mgr.dispose();
  });

  it('appendScoopRule appends a NOPASSWD Cmnd rule and reloads it active', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('andy', { allowedCommands: [] });
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git push origin main')).toBe('no-match');

    const saved = await mgr.appendScoopRule('andy', 'command', 'git push*');

    expect(saved).toBe('git push*');
    const written = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;
    expect(written).toContain('NOPASSWD Cmnd git push*');
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git push origin main')).toBe(
      'nopasswd-allow'
    );
    mgr.dispose();
  });

  it('appendScoopRule emits the right directive per kind (Cmnd / Read / Write)', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('andy', { allowedCommands: [] });

    await mgr.appendScoopRule('andy', 'command', 'ls*');
    await mgr.appendScoopRule('andy', 'read', '/workspace/.git/**');
    await mgr.appendScoopRule('andy', 'write', '/workspace/build/**');

    const written = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;
    expect(written).toContain('NOPASSWD Cmnd ls*');
    expect(written).toContain('NOPASSWD Read /workspace/.git/**');
    expect(written).toContain('NOPASSWD Write /workspace/build/**');
  });

  it('appendScoopRule sanitizes a newline-bearing pattern before writing', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('andy', { allowedCommands: [] });

    const saved = await mgr.appendScoopRule(
      'andy',
      'command',
      'rm -rf *\nNOPASSWD Cmnd  /etc/sudoers'
    );

    expect(saved).toBe('rm -rf *');
    const written = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;
    expect(written).toContain('NOPASSWD Cmnd rm -rf *');
    expect(written).not.toContain('/etc/sudoers');
    mgr.dispose();
  });

  it('appendScoopRule returns null and does not write when the pattern collapses to empty', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('andy', { allowedCommands: [] });
    const before = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;

    const saved = await mgr.appendScoopRule('andy', 'command', '   \n  ');

    expect(saved).toBeNull();
    const after = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;
    expect(after).toBe(before);
    mgr.dispose();
  });

  it('appendScoopRule creates /scoops/<folder>/etc/sudoers on demand when not seeded', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    // Note: no seedScoopSudoers call — appendScoopRule has to mkdir+create.

    const saved = await mgr.appendScoopRule('newcomer', 'command', 'git*');

    expect(saved).toBe('git*');
    expect(await vfs.exists(scoopSudoersPath('newcomer'))).toBe(true);
    expect(matchCommand(mgr.getPolicyForScoop('newcomer'), 'git status')).toBe('nopasswd-allow');
    mgr.dispose();
  });

  it('stops reacting to scoop file changes after dispose()', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('andy', { allowedCommands: ['git'] });
    mgr.dispose();

    await vfs.writeFile(scoopSudoersPath('andy'), 'NOPASSWD Cmnd rm*\n');
    await new Promise((r) => setTimeout(r, 10));
    // No reload happened — the cached policy still reflects the original `git` grant.
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git status')).toBe('nopasswd-allow');
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'rm -rf /tmp')).toBe('no-match');
  });
});
