/**
 * Tests for `SudoFS` — filesystem-level sudo enforcement.
 *
 * Covers read/write gating against the sudoers policy, `EACCES` on deny,
 * `NOPASSWD` persistence to `/etc/sudoers.d/granted` + reuse (no re-prompt),
 * the hardcoded sudoers self-protection invariant, and ACL-correct sync
 * fast-paths (`statSync`/`readDirSync` force async fallback for gated reads).
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsError, VirtualFS } from '../../src/fs/index.js';
import { createSudoFs, GRANTED_FILE } from '../../src/fs/sudo-fs.js';
import { mergePolicies, parseSudoers, type SudoersPolicy } from '../../src/shell/sudo/sudoers.js';
import type { SudoDecision, SudoRequest } from '../../src/sudo/types.js';

function makeBroker(decision: SudoDecision | ((req: SudoRequest) => SudoDecision)) {
  const calls: SudoRequest[] = [];
  const broker = {
    async requestApproval(req: SudoRequest): Promise<SudoDecision> {
      calls.push(req);
      return typeof decision === 'function' ? decision(req) : decision;
    },
  };
  return { calls, broker };
}

describe('SudoFS', () => {
  let vfs: VirtualFS;
  let policy: SudoersPolicy;
  const getPolicy = () => policy;

  beforeEach(async () => {
    indexedDB.deleteDatabase('test-sudo-fs');
    vfs = await VirtualFS.create({ dbName: 'test-sudo-fs', wipe: true });
    policy = mergePolicies(parseSudoers('Read /shared/secrets/**\nWrite /workspace/.git/**'));
    await vfs.mkdir('/workspace/.git', { recursive: true });
    await vfs.mkdir('/shared/secrets', { recursive: true });
    await vfs.writeFile('/workspace/note.txt', 'hi');
    await vfs.writeFile('/workspace/.git/config', 'cfg');
    await vfs.writeFile('/shared/secrets/api.key', 'sekret');
  });
  afterEach(() => {
    vfs.dispose?.();
  });

  it('gates protected reads and passes through non-protected reads', async () => {
    const { calls, broker } = makeBroker({ decision: 'allow' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    expect(await sfs.readTextFile('/shared/secrets/api.key')).toBe('sekret');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'read', detail: '/shared/secrets/api.key' });

    expect(await sfs.readTextFile('/workspace/note.txt')).toBe('hi');
    expect(calls).toHaveLength(1);
  });

  it('throws EACCES when a gated write is denied', async () => {
    const { calls, broker } = makeBroker({ decision: 'deny' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    await expect(sfs.writeFile('/workspace/.git/config', 'evil')).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(calls[0]).toMatchObject({ kind: 'write', detail: '/workspace/.git/config' });
    // Non-protected write is untouched.
    await sfs.writeFile('/workspace/note.txt', 'changed');
    expect(await vfs.readTextFile('/workspace/note.txt')).toBe('changed');
    expect(calls).toHaveLength(1);
  });

  it('always-protects writes to sudoers files regardless of policy', async () => {
    policy = parseSudoers(''); // empty policy — only self-protection active
    const { calls, broker } = makeBroker({ decision: 'deny' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    await expect(sfs.writeFile('/etc/sudoers', 'x')).rejects.toBeInstanceOf(FsError);
    await expect(sfs.mkdir('/etc/sudoers.d/extra')).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls).toHaveLength(2);
    // Reads of sudoers are allowed (visudo-style) — no prompt.
    await vfs.writeFile('/etc/sudoers', 'Cmnd rm -rf *');
    expect(await sfs.readTextFile('/etc/sudoers')).toContain('Cmnd');
    expect(calls).toHaveLength(2);
  });

  it('persists a NOPASSWD grant on "always" and stops re-prompting', async () => {
    const { calls, broker } = makeBroker({ decision: 'always', pattern: '/workspace/.git/**' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    await sfs.writeFile('/workspace/.git/config', 'one');
    expect(calls).toHaveLength(1);

    const granted = await vfs.readTextFile(GRANTED_FILE);
    expect(granted).toContain('NOPASSWD Write /workspace/.git/**');

    // Subsequent writes under the granted glob no longer prompt.
    await sfs.writeFile('/workspace/.git/HEAD', 'ref');
    await sfs.writeFile('/workspace/.git/config', 'two');
    expect(calls).toHaveLength(1);
    expect(await vfs.readTextFile('/workspace/.git/config')).toBe('two');
  });

  it('gates the source path as a read in rename (before writes) and moves on allow', async () => {
    const { calls, broker } = makeBroker({ decision: 'allow' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    // Source is read-protected (`Read /shared/secrets/**`); destination is not.
    await sfs.rename('/shared/secrets/api.key', '/workspace/moved.key');

    // A read approval was requested on the SOURCE path before the move.
    expect(calls.some((c) => c.kind === 'read' && c.detail === '/shared/secrets/api.key')).toBe(
      true
    );
    expect(await vfs.exists('/workspace/moved.key')).toBe(true);
    expect(await vfs.exists('/shared/secrets/api.key')).toBe(false);
  });

  it('blocks the rename when the source read approval is denied', async () => {
    const { calls, broker } = makeBroker({ decision: 'deny' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    await expect(
      sfs.rename('/shared/secrets/api.key', '/workspace/moved.key')
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect(calls[0]).toMatchObject({ kind: 'read', detail: '/shared/secrets/api.key' });
    // No silent move-then-read: the source stays put, the destination is absent.
    expect(await vfs.exists('/shared/secrets/api.key')).toBe(true);
    expect(await vfs.exists('/workspace/moved.key')).toBe(false);
  });

  it('sanitizes a newline-bearing pattern at the default persist sink', async () => {
    const { broker } = makeBroker({
      decision: 'always',
      pattern: '/workspace/.git/**\nNOPASSWD Write /etc/sudoers',
    });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    await sfs.writeFile('/workspace/.git/config', 'one');

    const granted = await vfs.readTextFile(GRANTED_FILE);
    // Only the first trimmed line is written — no injected second rule.
    expect(granted).toContain('NOPASSWD Write /workspace/.git/**');
    expect(granted).not.toContain('/etc/sudoers');
  });

  it('forces async fallback for gated sync fast-paths', () => {
    const { broker } = makeBroker({ decision: 'allow' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });

    // Protected read path → null so the adapter falls back to async (gated).
    expect(sfs.statSync('/shared/secrets/api.key')).toBeNull();
    expect(sfs.readDirSync('/shared/secrets')).toBeNull();
    // Non-protected path → real synchronous result, no fallback.
    expect(sfs.statSync('/workspace/note.txt')?.type).toBe('file');
    expect(sfs.readDirSync('/workspace')).not.toBeNull();
  });

  it('forwards non-gated methods transparently', async () => {
    const { broker } = makeBroker({ decision: 'deny' });
    const sfs = createSudoFs(vfs, { broker, getPolicy });
    expect(sfs.canWrite('/workspace/anything')).toBe(true);
    expect(await sfs.exists('/workspace/note.txt')).toBe(true);
  });
});
