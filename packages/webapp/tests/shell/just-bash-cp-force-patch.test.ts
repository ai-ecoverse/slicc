import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// cp accepts -f / --force (vercel-labs/just-bash#494). Upstream 3.4.2 answered
// "cp: invalid option -- 'f'", so automake install rules such as ImageMagick's
// `cp -f $^ $@` for its .pc files failed.
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash cp -f patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => {
    const r = await new Shell().exec(script);
    return `${r.stdout}${r.stderr}`;
  };

  it('copies with -f and --force', async () => {
    expect(await run('echo a > /a; cp -f /a /b && cat /b')).toBe('a\n');
    expect(await run('echo a > /a; cp --force /a /b && cat /b')).toBe('a\n');
  });

  it('overwrites a read-only destination', async () => {
    expect(await run('echo a > /a; echo b > /c; chmod 444 /c; cp -f /a /c && cat /c')).toBe('a\n');
  });

  it('combines with other flags, and -n still wins', async () => {
    expect(await run('mkdir -p /d/s; echo x > /d/s/f; cp -rf /d /e && cat /e/s/f')).toBe('x\n');
    expect(await run('echo a > /a; echo b > /c; cp -n -f /a /c; cat /c')).toBe('b\n');
  });

  it('lists -f in --help', async () => {
    expect(await run('cp --help')).toContain('-f, --force');
  });
});
