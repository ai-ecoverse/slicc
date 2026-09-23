import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream `ls -l` printed a hardcoded -rw-r--r-- / drwxr-xr-x, so an
// executable ./configure looked non-executable even though `test -x` passed.
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash ls -l mode patch (%s)', (_runtime, Shell) => {
  it('shows the real permission bits for files and directories', async () => {
    const shell = new Shell();
    const out = await shell.exec(
      'echo x > /f; chmod 755 /f; mkdir /d; chmod 700 /d; ls -l /f; ls -ld /d; ls -l / | grep " f$"'
    );
    const lines = out.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^-rwxr-xr-x /);
    expect(lines[1]).toMatch(/^drwx------ /);
    expect(lines[2]).toMatch(/^-rwxr-xr-x /);
  });

  it('keeps the usual defaults for untouched entries', async () => {
    const out = await new Shell().exec('echo x > /g; mkdir /e; ls -l /g; ls -ld /e');
    expect(out.stdout).toMatch(/^-rw-r--r-- .*\/g\ndrwxr-xr-x /);
  });
});
