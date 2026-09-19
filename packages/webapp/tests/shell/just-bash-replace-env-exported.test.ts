/**
 * Guard for the just-bash hunk that keeps `exec({ env, replaceEnv: true })`
 * vars exported. `sh`/`bash -c` inherit `exportedEnv`, not the full `ctx.env`
 * map, so a replace that never updated `exportedVars` dropped `MARKER` in the
 * nested shell while a directly-executed `printenv` still saw it (#3285).
 */
import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

const env = { MARKER: 'YES' };

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash replaceEnv exports into nested shells (%s)', (_runtime, Shell) => {
  it('a directly-executed binary keeps the replaced env', async () => {
    const shell = new Shell({ cwd: '/' });
    const result = await shell.exec('printenv MARKER', { env, replaceEnv: true });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('YES');
  });

  it('sh -c keeps the replaced env', async () => {
    const shell = new Shell({ cwd: '/' });
    const printenv = await shell.exec('sh', {
      args: ['-c', 'printenv MARKER'],
      env,
      replaceEnv: true,
    });
    expect(printenv.exitCode).toBe(0);
    expect(printenv.stdout.trim()).toBe('YES');
    const echo = await shell.exec('sh', {
      args: ['-c', 'echo [$MARKER]'],
      env,
      replaceEnv: true,
    });
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout.trim()).toBe('[YES]');
  });

  it('bash -c keeps the replaced env', async () => {
    const shell = new Shell({ cwd: '/' });
    const result = await shell.exec('bash', {
      args: ['-c', 'echo [$MARKER]'],
      env,
      replaceEnv: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('[YES]');
  });

  it('an unexported in-shell assignment still does not leak into sh -c', async () => {
    const shell = new Shell({ cwd: '/' });
    const local = await shell.exec("LOCALVAR=hidden; sh -c 'echo [$LOCALVAR]'");
    expect(local.stdout.trim()).toBe('[]');
    const exported = await shell.exec("export SHAREDVAR=visible; sh -c 'echo [$SHAREDVAR]'");
    expect(exported.stdout.trim()).toBe('[visible]');
  });
});
