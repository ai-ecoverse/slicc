import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream iterated `for x; do` by splitting the joined "$@" on spaces and
// dropping empty parameters. libtool's compile mode walks its arguments with
// `for arg`, so `-DPACKAGE_STRING="lcms2 2.17"` reached clang as two words
// (vercel-labs/just-bash#485).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash for-without-in patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('iterates one word per positional parameter', async () => {
    expect(await run('f () { for a; do echo "[$a]"; done; }; f "a b" "" c')).toBe(
      '[a b]\n[]\n[c]\n'
    );
    expect(await run('f () { for a do echo "<$a>"; done; }; f "x  y" z')).toBe('<x  y>\n<z>\n');
    expect(await run('set -- "-DP=\\"a b\\"" -c; for a; do echo "[$a]"; done')).toBe(
      '[-DP="a b"]\n[-c]\n'
    );
  });

  it('runs no iterations without parameters', async () => {
    expect(await run('set --; for a; do echo never; done; echo done')).toBe('done\n');
  });
});
