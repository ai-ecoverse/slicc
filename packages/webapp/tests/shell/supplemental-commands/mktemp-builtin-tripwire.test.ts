/**
 * Tripwire: fail the moment `just-bash` ships a builtin `mktemp`.
 *
 * `src/shell/supplemental-commands/mktemp-command.ts` is an overlay, ported
 * from [vercel-labs/just-bash#377](https://github.com/vercel-labs/just-bash/pull/377)
 * so that callers get the command before that PR lands (#2267). A supplemental
 * command SHADOWS a builtin of the same name, so once the builtin exists the
 * overlay keeps winning and nothing else in the suite notices — the tests below
 * would all still pass against the overlay, and the weaker probe-then-create in
 * `createExclusive` would keep running in place of upstream's atomic
 * `IFileSystem.createExclusive`. That is the failure this file exists to
 * prevent: silence, not breakage.
 *
 * ## When this test fails, delete the overlay
 *
 * A red assertion here means the builtin arrived and the overlay is now dead
 * weight. Remove it rather than adjusting this test:
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

/** A bare interpreter: no supplemental commands, so only builtins answer. */
function builtinsOnly(): Bash {
  return new Bash({ files: { '/tmp/.keep': '' } });
}

describe('just-bash builtin mktemp tripwire (#2267)', () => {
  it('has no builtin mktemp — when it does, delete the overlay (see file header)', async () => {
    const result = await builtinsOnly().exec('mktemp');
    expect(result.exitCode, 'just-bash now ships mktemp; remove our overlay').toBe(127);
    expect(result.stderr).toContain('mktemp: command not found');
  });

  it('does not resolve mktemp on the builtin PATH', async () => {
    // `command -v` answers from the registry rather than by running anything,
    // so it trips even if a future builtin exits non-zero on a bare invocation.
    const result = await builtinsOnly().exec('command -v mktemp');
    expect(result.exitCode, 'just-bash now registers mktemp; remove our overlay').toBe(1);
    expect(result.stdout).toBe('');
  });

  it('our overlay is what answers mktemp today', async () => {
    // The other half of the invariant: the overlay must actually be reachable,
    // so a green tripwire cannot be mistaken for "mktemp works now".
    const { createMktempCommand } = await import(
      '../../../src/shell/supplemental-commands/mktemp-command.js'
    );
    expect(createMktempCommand().name).toBe('mktemp');
  });
});
