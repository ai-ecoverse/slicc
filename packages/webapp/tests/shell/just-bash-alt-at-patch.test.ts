import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream joined the positional parameters into one word for `${1+"$@"}`,
// the argument-forwarding idiom of autoconf/libtool scripts. libtool calls
// every option hook with `eval $hook '${1+"$@"}'`, so its hooks saw the
// whole command line as one word (vercel-labs/just-bash#481).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash ${1+"$@"} patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) =>
    (await new Shell().exec(`f () { echo "n=$# [$1]"; }; ${script}`)).stdout;

  it('forwards each parameter as its own word', async () => {
    expect(await run('set -- a "b c" d; f ${1+"$@"}; eval f \'${1+"$@"}\'')).toBe(
      'n=3 [a]\nn=3 [a]\n'
    );
    expect(await run('set -- a "b c"; f ${x-"$@"}; f ${1:+"$@"}; f ${x:-"${@}"}')).toBe(
      'n=2 [a]\nn=2 [a]\nn=2 [a]\n'
    );
    expect(await run('set -- "" b; f ${1+"$@"}')).toBe('n=2 []\n');
  });

  it('gives nothing when there are no parameters or the branch is not taken', async () => {
    expect(await run('set --; f ${1+"$@"}; f ${x-"$@"}')).toBe('n=0 []\nn=0 []\n');
    expect(await run('set -- a b; v=1; f ${v:-"$@"}; f ${v+"$@"} tail')).toBe('n=1 [1]\nn=3 [a]\n');
  });

  it('still joins "$*" and a "$@" with adjacent text', async () => {
    expect(await run('set -- "a b" c; f ${1+"$*"}; f ${1+"x$@"}')).toBe(
      'n=1 [a b c]\nn=1 [xa b c]\n'
    );
  });
});
