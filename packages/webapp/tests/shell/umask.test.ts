/**
 * `umask` is a real builtin (just-bash patch, vercel-labs/just-bash#475): the
 * mask is shell state, and files the shell creates on the VFS honour it.
 * autoconf's config.guess, libtool and every config.status run
 * `(umask 077 && mkdir "$tmp")`, so the old refusal stopped every autotools
 * build.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

describe('umask', () => {
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    const fs = await VirtualFS.create({ dbName: `test-umask-${dbCounter++}`, wipe: true });
    await fs.mkdir('/w', { recursive: true });
    shell = new AlmostBashShellHeadless({ fs, cwd: '/w' });
  });

  const run = async (cmd: string) => {
    const r = await shell.executeCommand(cmd);
    return { out: r.stdout, err: r.stderr, code: r.exitCode };
  };
  // Permission bits only: `stat -c %a` on the VFS also prints the file-type bits.
  const perm = (m: string) => (Number.parseInt(m, 8) & 0o7777).toString(8);
  const modes = async (...paths: string[]) =>
    (await run(`stat -c '%a' ${paths.join(' ')}`)).out.trim().split('\n').map(perm);

  it('prints the default mask in octal, symbolic and reusable forms', async () => {
    expect((await run('umask; umask -S; umask -p; umask -p -S')).out).toBe(
      '0022\nu=rwx,g=rx,o=rx\numask 0022\numask -S u=rwx,g=rx,o=rx\n'
    );
  });

  it('applies the mask to files and directories the shell creates', async () => {
    await run('umask 077; echo x > f; touch t; mkdir d; mkdir -p p/q/r');
    expect(await modes('f', 't', 'd', 'p', 'p/q/r')).toEqual(['600', '600', '700', '700', '700']);
    await run('umask 002; echo y > g; mkdir e');
    expect(await modes('g', 'e')).toEqual(['664', '775']);
    await run('umask 022; echo z > h; mkdir i');
    expect(await modes('h', 'i')).toEqual(['644', '755']);
  });

  it('gives mkdir -p parents u+wx, as POSIX requires', async () => {
    await run('umask 0277; mkdir -p a/b');
    expect(await modes('a', 'a/b')).toEqual(['700', '500']);
  });

  it('leaves the mode of an existing file alone', async () => {
    await run('echo 1 > keep; chmod 640 keep; umask 077; echo 2 > keep; echo 3 >> keep');
    expect(await modes('keep')).toEqual(['640']);
  });

  it('keeps the mask between commands, and subshells and substitutions get a copy', async () => {
    await run('umask 027');
    expect((await run('umask')).out).toBe('0027\n');
    expect(
      (await run('(umask 077; umask); umask; x=$(umask 007; umask); echo $x; umask')).out
    ).toBe('0077\n0027\n0007\n0027\n');
  });

  it('is inherited by bash -c and scripts run by path, which cannot change it for the caller', async () => {
    await run('printf "umask\\numask 077\\necho s > from-script\\n" > s.sh; chmod +x s.sh');
    await run('umask 027');
    expect((await run('bash -c umask; ./s.sh; umask')).out).toBe('0027\n0027\n0027\n');
    expect(await modes('from-script')).toEqual(['600']);
  });

  it('takes symbolic modes', async () => {
    expect(
      (
        await run(
          'umask u=rwx,g=rx,o=; umask; umask g-x; umask; umask a+rwx; umask; umask o=r; umask'
        )
      ).out
    ).toBe('0027\n0037\n0000\n0003\n');
    expect((await run('umask -S 077')).out).toBe('u=rwx,g=,o=\n');
  });

  it('rejects bad modes with bash messages and exit codes', async () => {
    expect(await run('umask 8')).toMatchObject({
      code: 1,
      err: 'bash: umask: 8: octal number out of range\n',
    });
    expect(await run('umask 1777')).toMatchObject({ code: 1 });
    expect(await run('umask u=q')).toMatchObject({
      code: 1,
      err: "bash: umask: `q': invalid symbolic mode character\n",
    });
    expect(await run('umask u!r')).toMatchObject({
      code: 1,
      err: "bash: umask: `!': invalid symbolic mode operator\n",
    });
    expect(await run('umask -z')).toMatchObject({ code: 2 });
    expect((await run('umask')).out).toBe('0022\n');
  });

  it("runs config.status's temp-directory idiom", async () => {
    const r = await run(
      'tmp=; trap \'test -z "$tmp" || rm -fr "$tmp"\' 0; ' +
        '{ tmp=`(umask 077 && mktemp -d "./confXXXXXX") 2>/dev/null` && test -d "$tmp"; } || ' +
        '{ tmp=./conf$$-$RANDOM; (umask 077 && mkdir "$tmp"); } || echo FAILED; ' +
        'test -d "$tmp" && stat -c %a "$tmp"; umask'
    );
    expect(r.out).not.toContain('FAILED');
    const [dirMode, mask] = r.out.trim().split('\n');
    expect([perm(dirMode ?? ''), mask]).toEqual(['700', '0022']);
  });
});
