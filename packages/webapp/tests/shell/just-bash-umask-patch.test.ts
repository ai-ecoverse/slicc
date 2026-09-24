import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash umask patch (%s)', (_runtime, Shell) => {
  const run = async (cmd: string, umask?: number) => {
    const r = await new Shell().exec(cmd, umask === undefined ? {} : { umask });
    return { out: r.stdout, err: r.stderr, code: r.exitCode, umask: r.umask };
  };

  it('is a builtin that prints and sets the mask', async () => {
    expect((await run('type umask; umask; umask -S; umask -p')).out).toBe(
      'umask is a shell builtin\n0022\nu=rwx,g=rx,o=rx\numask 0022\n'
    );
    expect((await run('umask 027; umask; umask g+w,o=; umask')).out).toBe('0027\n0007\n');
  });

  it('applies the mask to mkdir, mkdir -p and touch', async () => {
    const r = await run('umask 077; mkdir /d; mkdir -p /p/q; touch /t; stat -c %a /d /p /p/q /t');
    expect(r.out).toBe('700\n700\n700\n600\n');
  });

  it('scopes the mask to subshells and substitutions, and inherits it into bash -c', async () => {
    const r = await run('umask 027; (umask 077); x=$(umask 007); umask; bash -c umask');
    expect(r.out).toBe('0027\n0027\n');
  });

  it('takes the mask from exec options and reports the final one', async () => {
    expect(await run('umask', 0o077)).toMatchObject({ out: '0077\n', umask: 0o077 });
    expect((await run('umask 002')).umask).toBe(0o002);
    expect((await run('(umask 077)')).umask).toBe(0o022);
  });

  it('rejects bad modes like bash', async () => {
    expect(await run('umask 9')).toMatchObject({
      code: 1,
      err: 'bash: umask: 9: octal number out of range\n',
    });
    expect(await run('umask -x')).toMatchObject({ code: 2 });
  });
});
