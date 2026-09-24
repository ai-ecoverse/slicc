import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream only took an option value as the next argument, so the attached
// forms POSIX allows (`xargs -n2`, `-I{}`, `-d,`) failed with "invalid
// option" (vercel-labs/just-bash#466). automake's configure probes
// `xargs -n2`.
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash xargs attached option values patch (%s)', (_runtime, Shell) => {
  const run = async (cmd: string) => {
    const r = await new Shell().exec(cmd);
    return { out: r.stdout, err: r.stderr, code: r.exitCode };
  };

  it('accepts -nN, -I{}, -dX and -PN', async () => {
    expect((await run('echo 1 2 3 | xargs -n2 echo')).out).toBe('1 2\n3\n');
    expect((await run('echo a b | xargs -I{} echo x{}')).out).toBe('xa\nxb\n');
    expect((await run('printf "a,b" | xargs -d, -n1 echo')).out).toBe('a\nb\n');
    expect((await run('echo a b | xargs -P2 -n1 echo')).code).toBe(0);
  });

  it('keeps the separate-argument forms and boolean clusters', async () => {
    expect((await run('echo 1 2 3 | xargs -n 2 echo')).out).toBe('1 2\n3\n');
    expect((await run('echo a | xargs -I {} echo [{}]')).out).toBe('[a]\n');
    expect((await run('printf "" | xargs -rt echo')).out).toBe('');
  });

  it("passes automake's xargs -n probe", async () => {
    const probe = 'test "`echo 1 2 3 | xargs -n2 echo`" = "1 2\n3" && echo works';
    expect((await run(probe)).out).toBe('works\n');
  });

  it('still validates the attached value', async () => {
    const r = await run('echo 1 | xargs -nx echo');
    expect(r.code).toBe(1);
    expect(r.err).toContain("invalid number for -n: 'x'");
  });
});
