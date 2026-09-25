import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

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
