import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream expanded the command word as ONE string, so `$CC -c x.c` with
// CC="emcc -O2" looked for a command named "emcc -O2". Build scripts do this
// everywhere (zlib's configure: `got=\`( $* ) 2>&1\``).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash command-name word splitting patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('splits an unquoted expansion in the command position', async () => {
    expect(await run('CC="echo cc -O2"; $CC -c x.c')).toBe('cc -O2 -c x.c\n');
    expect(await run('set -- echo a b; $*')).toBe('a b\n');
  });

  it("runs zlib configure's try(): $* inside a subshell inside backticks", async () => {
    const script = 'try() { got=`( $* ) 2>&1`; echo "rc=$? got=$got"; }; try echo a b';
    expect(await run(script)).toBe('rc=0 got=a b\n');
  });

  it('keeps a quoted command word whole and skips an empty expansion', async () => {
    const quoted = await new Shell().exec('X="echo a"; "$X"');
    expect(quoted.exitCode).toBe(127);
    expect(await run('E=; $E echo still')).toBe('still\n');
  });
});
