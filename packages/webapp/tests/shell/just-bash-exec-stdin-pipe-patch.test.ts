import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash exec-stdin pipe patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('a pipe feeds its stage even after exec </dev/null', async () => {
    expect(await run('exec </dev/null; printf hi | cat; echo')).toBe('hi\n');
    expect(await run('exec </dev/null; x=$(printf hi | cat); echo "[$x]"')).toBe('[hi]\n');
    expect(
      await run('exec </dev/null; printf "1\\n2\\n" | while read v; do echo "v=$v"; done')
    ).toBe('v=1\nv=2\n');
  });

  it('keeps the persistent fd 0 for commands without a pipe', async () => {
    const script =
      'printf "a\\nb\\n" > /f; exec </f; read l; echo "[$l]"; printf x | cat; echo; cat';
    expect(await run(script)).toBe('[a]\nx\nb\n');
    expect(await run('exec </dev/null; cat; echo end')).toBe('end\n');
  });

  it('an explicit < still wins inside a pipeline', async () => {
    expect(await run('printf zz > /z; exec </dev/null; printf hi | cat </z; echo')).toBe('zz\n');
  });
});
