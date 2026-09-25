import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Backport of vercel-labs/just-bash#400 (merged, not yet released): an
// assignment-only command exits 0, or with its last command substitution's
// status. Upstream 3.4.2 returned the previous command's status, so automake's
// `(CDPATH=… && cd $subdir && $(MAKE) …)` never ran make after a failed `test`.
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash assignment status patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('exits 0 after a failed command', async () => {
    expect(await run('false; x=1; echo rc=$?')).toBe('rc=0\n');
    expect(await run('false; x=1 y=2 && echo ran')).toBe('ran\n');
  });

  it('takes the status of a command substitution in the assignment', async () => {
    expect(await run('true; x=$(false); echo rc=$?')).toBe('rc=1\n');
    expect(await run('false; x=$(true); echo rc=$?')).toBe('rc=0\n');
    expect(await run('false; y="a$(exit 4)b"; echo rc=$?')).toBe('rc=4\n');
  });

  it('still expands $? to the previous status inside the assignment', async () => {
    expect(await run('false; x=$?; echo x=$x')).toBe('x=1\n');
  });

  it("runs automake's recursive-make step after a failed test", async () => {
    const script =
      'mkdir -p /w/dec; cd /w; for subdir in dec; do if test "$subdir" = "."; then :; else t=all; fi; ' +
      '(CDPATH="${ZSH_VERSION+.}:" && cd $subdir && echo "make $t in $PWD") || echo FAILED; done';
    expect(await run(script)).toBe('make all in /w/dec\n');
  });
});
