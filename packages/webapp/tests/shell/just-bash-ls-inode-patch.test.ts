import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// autoconf checks its working directory with `ls -di .` twice and compares the
// output; upstream rejected -i ("invalid option -- 'i'"), so every configure
// stopped with "working directory cannot be determined".
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash ls -i patch (%s)', (_runtime, Shell) => {
  it('prints an inode number before the name for ls -di', async () => {
    const r = await new Shell().exec('mkdir /d; cd /d; ls -di .');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^\d+ \.\n$/);
  });

  it("passes autoconf's working-directory check", async () => {
    const script =
      'mkdir -p /w/x; cd /w/x; ac_pwd=`pwd` && ac_ls_di=`ls -di .` && ac_pwd_ls_di=`cd "$ac_pwd" && ls -di .` && test "X$ac_ls_di" = "X$ac_pwd_ls_di" && echo ok';
    expect((await new Shell().exec(script)).stdout).toBe('ok\n');
  });

  it('leaves output without -i unchanged', async () => {
    expect((await new Shell().exec('mkdir /e; ls -d /e')).stdout).toBe('/e\n');
  });
});
