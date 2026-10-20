/**
 * Tripwire: fail the moment SLICC's filesystem can run just-bash's builtin
 * `mktemp`.
 *
 * `src/shell/supplemental-commands/mktemp-command.ts` is an overlay, ported
 * from [vercel-labs/just-bash#377](https://github.com/vercel-labs/just-bash/pull/377)
 * so that callers got the command before that PR landed (#2267). just-bash
 * 3.6.0 ships the builtin, but it creates through the optional
 * `IFileSystem.createExclusive` and answers ENOSYS ("filesystem cannot create
 * entries atomically") on a filesystem without it. `VfsAdapter` has no
 * `createExclusive` yet, so the overlay (whose probe-then-create needs no new
 * primitive) still shadows the builtin. A supplemental command SHADOWS a
 * builtin of the same name, so once `VfsAdapter` gains the method the overlay
 * keeps winning and nothing else in the suite notices. That is the failure
 * this file exists to prevent: silence, not breakage.
 *
 * ## When this test fails, delete the overlay
 *
 * A red assertion here means `VfsAdapter` can create atomically and the
 * overlay is now dead weight. Remove it rather than adjusting this test:
 *
 * 1. `git rm packages/webapp/src/shell/supplemental-commands/mktemp-command.ts`
 * 2. `git rm packages/webapp/tests/shell/supplemental-commands/mktemp-command.test.ts`
 * 3. Drop the `createMktempCommand()` import and registration from
 *    `packages/webapp/src/shell/supplemental-commands/index.ts`.
 * 4. In `docs/shell-reference.md`, delete the `mktemp` row from the
 *    supplemental-command table. The `$TMPDIR` section stays: the builtin
 *    resolves against `$TMPDIR` too, so this runtime's per-unit pin is still
 *    what points it at a writable directory.
 * 5. `git rm` this file.
 * 6. Re-run the suite. Nothing outside those files should need a change — the
 *    overlay was ported flag-for-flag and diagnostic-for-diagnostic precisely
 *    so this swap is invisible to callers.
 *
 * If the builtin has landed but differs from the overlay in a way that breaks a
 * caller, that is an upstream bug worth reporting rather than a reason to keep
 * a second implementation alive.
 */

import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

/** A bare interpreter: no supplemental commands, so only builtins answer. */
function builtinsOnly(): Bash {
  return new Bash({ files: { '/tmp/.keep': '' } });
}

describe('just-bash builtin mktemp tripwire (#2267)', () => {
  it('just-bash ships a builtin mktemp (since 3.6.0)', async () => {
    const result = await builtinsOnly().exec('command -v mktemp');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/mktemp\n');
  });

  it('VfsAdapter has no createExclusive — when it does, delete the overlay (see file header)', () => {
    expect(
      'createExclusive' in VfsAdapter.prototype,
      'VfsAdapter now creates atomically; remove our mktemp overlay'
    ).toBe(false);
  });

  it('our overlay is what answers mktemp today', async () => {
    // The other half of the invariant: the overlay must actually be reachable,
    // so a green tripwire cannot be mistaken for "the builtin works here".
    const { createMktempCommand } = await import(
      '../../../src/shell/supplemental-commands/mktemp-command.js'
    );
    expect(createMktempCommand().name).toBe('mktemp');
  });
});
