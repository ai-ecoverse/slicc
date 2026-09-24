import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash ls -t / -L patch (%s)', (_runtime, Shell) => {
  const setup =
    'mkdir /d; echo a > /d/a; echo b > /d/b; echo c > /d/c; ' +
    'touch -d "2020-01-01" /d/b; touch -d "2021-01-01" /d/c; touch -d "2022-01-01" /d/a; ';
  const run = async (cmd: string) => (await new Shell().exec(setup + cmd)).stdout;

  it('sorts directory entries newest first', async () => {
    expect(await run('ls -t /d')).toBe('a\nc\nb\n');
    expect(await run('ls -tr /d')).toBe('b\nc\na\n');
    expect(await run('ls /d')).toBe('a\nb\nc\n');
  });

  it('sorts file operands newest first, with -L accepted', async () => {
    const lines = (s: string) => s.split('\n').filter(Boolean);
    expect(lines(await run('ls -t /d/b /d/a'))).toEqual(['/d/a', '/d/b']);
    expect(lines(await run('ls -Lt /d/b /d/a'))).toEqual(['/d/a', '/d/b']);
  });

  it("passes automake's sanity check", async () => {
    const script =
      'touch -d "2020-01-01" /configure; echo x > conftest.file; set X `ls -Lt /configure conftest.file 2>/dev/null`; test "$2" = conftest.file && echo sane';
    expect((await new Shell().exec(script)).stdout).toBe('sane\n');
  });
});
