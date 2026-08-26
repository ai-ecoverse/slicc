/**
 * Tests for `SudoManager` — the live sudoers policy store.
 *
 * Covers default-template seeding on a fresh VFS, merge of `/etc/sudoers` +
 * `/etc/sudoers.d/*`, live reload via the `FsWatcher` when those files change,
 * the command-grant sink (used by the shell on "Always"), and watcher teardown.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  matchCommand,
  matchPath,
  parseSudoers,
  SUDOERS_FILE,
  scoopSudoersPath,
} from '../../src/base/sudoers.js';
import { FsWatcher } from '../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../src/fs/index.js';
import { FsError } from '../../src/fs/types.js';
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
  afterEach(async () => {
    await vfs.dispose?.();
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

  // #2195: /etc/models decides which provider:model combos a scoop may be
  // spawned with — including models billed to a different account — so editing
  // it is the one write the shipped template gates out of the box.
  it('gates writes to /etc/models straight from the shipped template', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    expect(matchPath(mgr.getPolicy(), 'write', '/etc/models')).toBe('require-approval');
    // Reads stay open: the agent has to be able to explain a refusal.
    expect(matchPath(mgr.getPolicy(), 'read', '/etc/models')).toBe('no-match');
    // …and it remains the ONLY active rule in the template.
    expect(matchCommand(mgr.getPolicy(), 'git push origin main')).toBe('no-match');
    expect(matchPath(mgr.getPolicy(), 'write', '/workspace/notes.md')).toBe('no-match');
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
    expect(text).not.toMatch(/^NOPASSWD Cmnd git( \*)?$/m);
    expect(text).not.toMatch(/^NOPASSWD Cmnd ls( \*)?$/m);
  });

  it('emits token-anchored Cmnd pairs per allowed command (no prefix over-match)', () => {
    const text = generateScoopSudoers({ allowedCommands: ['git', 'ls'] });
    // Token-anchored: the bare command AND the command-with-args, on a space.
    expect(text).toMatch(/^NOPASSWD Cmnd git$/m);
    expect(text).toMatch(/^NOPASSWD Cmnd git \*$/m);
    expect(text).toMatch(/^NOPASSWD Cmnd ls$/m);
    expect(text).toMatch(/^NOPASSWD Cmnd ls \*$/m);
    // The legacy prefix-match form is gone — `cat*` would match `catalog`.
    expect(text).not.toMatch(/^NOPASSWD Cmnd git\*$/m);
    expect(text).not.toMatch(/^NOPASSWD Cmnd ls\*$/m);
    // No unrestricted wildcard when an explicit list is provided.
    expect(text).not.toMatch(/^NOPASSWD Cmnd \*$/m);
  });

  it('token anchor rejects prefix over-match (e.g. `cat` does not allow `catalog`)', () => {
    const text = generateScoopSudoers({ allowedCommands: ['cat'] });
    const policy = parseSudoers(text);
    expect(matchCommand(policy, 'cat')).toBe('nopasswd-allow');
    expect(matchCommand(policy, 'cat /etc/hosts')).toBe('nopasswd-allow');
    // The legacy `cat*` form let these through; the anchored form must not.
    expect(matchCommand(policy, 'catalog')).toBe('no-match');
    expect(matchCommand(policy, 'cat-file')).toBe('no-match');
    expect(matchCommand(policy, 'catnap')).toBe('no-match');
  });

  // A single-file writable root is how a sandbox grants one file without its
  // siblings — the memory curator writes /workspace/CLAUDE.md but must not be
  // able to install into /workspace/skills/. Emitting only the `/**` form made
  // that impossible to express, since it never matches the file itself.
  it('grants a single-file writable root without granting its directory', () => {
    const policy = parseSudoers(
      generateScoopSudoers({ writablePaths: ['/workspace/CLAUDE.md'], allowedCommands: ['cat'] })
    );

    expect(matchPath(policy, 'write', '/workspace/CLAUDE.md')).toBe('nopasswd-allow');
    expect(matchPath(policy, 'write', '/workspace/skills/evil/SKILL.md')).toBe('no-match');
    expect(matchPath(policy, 'write', '/workspace/other.md')).toBe('no-match');
  });

  it('still grants the whole subtree for a directory writable root', () => {
    const policy = parseSudoers(
      generateScoopSudoers({ writablePaths: ['/workspace/'], allowedCommands: ['cat'] })
    );

    expect(matchPath(policy, 'write', '/workspace')).toBe('nopasswd-allow');
    expect(matchPath(policy, 'write', '/workspace/skills/ok/SKILL.md')).toBe('nopasswd-allow');
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
    expect(text).toMatch(/^NOPASSWD Cmnd git$/m);
    expect(text).toMatch(/^NOPASSWD Cmnd git \*$/m);
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
    for (const c of ['git', 'ls', 'cat']) {
      expect(text).toMatch(new RegExp(`^NOPASSWD Cmnd ${c}$`, 'm'));
      expect(text).toMatch(new RegExp(`^NOPASSWD Cmnd ${c} \\*$`, 'm'));
    }
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
  afterEach(async () => {
    await vfs.dispose?.();
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
    expect(written).toMatch(/^NOPASSWD Cmnd git$/m);
    expect(written).toMatch(/^NOPASSWD Cmnd git \*$/m);
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
      // Scoop is explicitly allowed `git`, which (as the anchored
      // `git` / `git *` pair) covers `git push`.
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

  it('grants /tmp to every scoop, even one whose seeded sudoers predates the grant', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    // A scoop whose on-disk sudoers was generated without any /tmp rule —
    // `ensureSudoersLoaded` never regenerates an existing file, so the grant
    // has to come from the built-in policy rather than from this body.
    await mgr.seedScoopSudoers('andy', {
      writablePaths: ['/scoops/andy'],
      allowedCommands: ['git'],
    });
    const written = (await vfs.readFile(scoopSudoersPath('andy'), {
      encoding: 'utf-8',
    })) as string;
    expect(written).not.toContain('/tmp');

    const policy = mgr.getPolicyForScoop('andy');
    expect(matchPath(policy, 'write', '/tmp/scratch.txt')).toBe('nopasswd-allow');
    expect(matchPath(policy, 'read', '/tmp/scratch.txt')).toBe('nopasswd-allow');
    // Unrelated out-of-sandbox writes still escalate.
    expect(matchPath(policy, 'write', '/workspace/file.txt')).toBe('no-match');
    mgr.dispose();
  });

  it('lets a global gating rule on /tmp still require approval', async () => {
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.writeFile(SUDOERS_FILE, 'Write /tmp/**\n');
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    // NOPASSWD wins over a plain match by design, so a user who wants /tmp
    // gated cannot get it from /etc/sudoers — document the actual behavior.
    expect(matchPath(mgr.getPolicyForScoop('andy'), 'write', '/tmp/x')).toBe('nopasswd-allow');
    expect(matchPath(mgr.getPolicy(), 'write', '/tmp/x')).toBe('require-approval');
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

  it('drops file-based grants when the sudoers file is removed, but keeps config grants (#2416)', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    await mgr.seedScoopSudoers('andy', { allowedCommands: ['git'] });
    // A file-only "Always" grant on top of the config-derived ones.
    await mgr.appendScoopRule('andy', 'command', 'ls*');
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git status')).toBe('nopasswd-allow');
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'ls -la')).toBe('nopasswd-allow');

    await vfs.rm(scoopSudoersPath('andy'), { recursive: false });
    await flush(() => matchCommand(mgr.getPolicyForScoop('andy'), 'ls -la') === 'no-match');
    // The file-only grant is gone…
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'ls -la')).toBe('no-match');
    // …but the config-derived sandbox grants stay authoritative in memory.
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git status')).toBe('nopasswd-allow');
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

  it('appendScoopRule preserves existing grants when reading the policy fails', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('andy', { allowedCommands: ['git'] });
    const path = scoopSudoersPath('andy');
    const before = (await vfs.readFile(path, { encoding: 'utf-8' })) as string;
    const readFile = vi
      .spyOn(vfs, 'readFile')
      .mockRejectedValueOnce(new FsError('EIO', 'transient read failure', path));

    await expect(mgr.appendScoopRule('andy', 'read', '/recordings/**')).rejects.toThrow(
      'transient read failure'
    );

    readFile.mockRestore();
    expect(await vfs.readFile(path, { encoding: 'utf-8' })).toBe(before);
    expect(matchCommand(mgr.getPolicyForScoop('andy'), 'git status')).toBe('nopasswd-allow');
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

// Issue #2416: a write inside a scoop's `writablePaths` must never raise an
// approval prompt, and an "Always" approval must never append a rule that is
// already present.
describe('SudoManager scoop config grants (issue #2416)', () => {
  let vfs: VirtualFS;
  let watcher: FsWatcher;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-sudo-cfg-${dbCounter++}`, wipe: true });
    watcher = new FsWatcher();
    vfs.setWatcher(watcher);
  });
  afterEach(async () => {
    await vfs.dispose?.();
  });

  it('registerScoopConfig makes writablePaths grants effective even when a stale sudoers file exists', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    // A sudoers file from a previous scoop generation with the same folder —
    // it predates the current config and lacks the /.playwright grant.
    await vfs.mkdir('/scoops/location-finder/etc', { recursive: true });
    await vfs.writeFile(scoopSudoersPath('location-finder'), 'NOPASSWD Write /shared/**\n');
    await mgr.reloadScoopPolicyByFolder('location-finder');

    // Without the config registered, the stale file wins and the write escalates.
    expect(
      matchPath(mgr.getPolicyForScoop('location-finder'), 'write', '/.playwright/screenshots/x.png')
    ).toBe('no-match');

    mgr.registerScoopConfig('location-finder', {
      writablePaths: ['/shared/', '/.playwright/', '/tmp/'],
    });

    const policy = mgr.getPolicyForScoop('location-finder');
    expect(matchPath(policy, 'write', '/.playwright/screenshots/x.png')).toBe('nopasswd-allow');
    expect(matchPath(policy, 'write', '/.playwright')).toBe('nopasswd-allow');
    // The file's own grants are still honoured alongside the config's.
    expect(matchPath(policy, 'write', '/shared/report.md')).toBe('nopasswd-allow');
    mgr.dispose();
  });

  it('config grants match regardless of trailing-slash / glob spelling', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();

    for (const spelling of ['/.playwright', '/.playwright/', '/.playwright/**']) {
      mgr.registerScoopConfig('speller', { writablePaths: [spelling] });
      const policy = mgr.getPolicyForScoop('speller');
      expect(matchPath(policy, 'write', '/.playwright/screenshots/x.png')).toBe('nopasswd-allow');
      expect(matchPath(policy, 'write', '/.playwright')).toBe('nopasswd-allow');
    }
    mgr.dispose();
  });

  it('registerScoopConfig notifies onPolicyReload for the folder', async () => {
    const reloads: Array<string | undefined> = [];
    const mgr = new SudoManager({
      fs: vfs,
      watcher,
      broker,
      onPolicyReload: (folder) => reloads.push(folder),
    });
    await mgr.init();
    reloads.length = 0;

    mgr.registerScoopConfig('finder', { writablePaths: ['/shared/'] });

    expect(reloads).toContain('finder');
    mgr.dispose();
  });

  it('seedScoopSudoers also registers the config-derived grants in memory', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('seeded', { writablePaths: ['/.playwright/'] });

    // Even if the on-disk file is later clobbered, the config grants hold.
    await vfs.writeFile(scoopSudoersPath('seeded'), '# wiped\n');
    await mgr.reloadScoopPolicyByFolder('seeded');

    expect(matchPath(mgr.getPolicyForScoop('seeded'), 'write', '/.playwright/a.png')).toBe(
      'nopasswd-allow'
    );
    mgr.dispose();
  });

  it('appendScoopRule does not append a rule that already exists (no duplicates)', async () => {
    const mgr = new SudoManager({ fs: vfs, watcher, broker });
    await mgr.init();
    await mgr.seedScoopSudoers('deduper', { writablePaths: ['/.playwright/'] });

    const saved = await mgr.appendScoopRule('deduper', 'write', '/.playwright/**');

    expect(saved).toBe('/.playwright/**');
    const body = (await vfs.readFile(scoopSudoersPath('deduper'), {
      encoding: 'utf-8',
    })) as string;
    const occurrences = body
      .split('\n')
      .filter((line) => line.trim() === 'NOPASSWD Write /.playwright/**').length;
    expect(occurrences).toBe(1);
    mgr.dispose();
  });
});
