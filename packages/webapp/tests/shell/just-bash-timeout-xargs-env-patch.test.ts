import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

type TimeoutCmd = {
  execute: (
    args: string[],
    ctx: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
};

async function loadTimeout(Shell: typeof Bash): Promise<TimeoutCmd> {
  const shell = new Shell();
  await shell.exec('timeout --help');
  const commands = (
    shell as unknown as {
      commands: Map<string, TimeoutCmd>;
    }
  ).commands;
  const cmd = commands.get('timeout');
  if (!cmd) throw new Error('timeout command was not registered');
  return cmd;
}

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash timeout/xargs child env patch (%s)', (_runtime, Shell) => {
  const run = async (cmd: string) => {
    const r = await new Shell().exec(cmd);
    return { out: r.stdout, err: r.stderr, code: r.exitCode };
  };

  it('timeout and xargs keep an exported variable, like time', async () => {
    expect((await run('export X=1; printenv X')).out.trim()).toBe('1');
    expect((await run('export X=1; timeout 5 printenv X')).out.trim()).toBe('1');
    expect((await run('export X=1; echo X | xargs printenv')).out.trim()).toBe('1');
    expect((await run('export X=1; (time printenv X) 2>/dev/null')).out.trim()).toBe('1');
  });

  it('HOME and a saved secret survive timeout', async () => {
    const home = (await run('printenv HOME')).out.trim();
    expect(home.length).toBeGreaterThan(1);
    expect((await run('timeout 5 printenv HOME')).out.trim()).toBe(home);
    expect(
      (await run('export SEARCH_API_KEY=s3cret; timeout 5 printenv SEARCH_API_KEY')).out.trim()
    ).toBe('s3cret');
  });

  it('unset HOME stays unset under timeout', async () => {
    expect((await run('unset HOME; printenv HOME')).out.trim()).toBe('');
    expect((await run('unset HOME; timeout 5 printenv HOME')).out.trim()).toBe('');
    expect((await run('unset HOME; echo HOME | xargs printenv')).out.trim()).toBe('');
  });

  it('unexported locals do not leak into timeout or xargs children', async () => {
    expect((await run("X=local; sh -c 'printenv X'")).out.trim()).toBe('');
    expect((await run("X=local; timeout 5 sh -c 'printenv X'")).out.trim()).toBe('');
    expect((await run('X=local; echo X | xargs printenv')).out.trim()).toBe('');
    expect((await run("export X=1; timeout 5 sh -c 'printenv X'")).out.trim()).toBe('1');
  });

  it('reports missing operand and invalid duration', async () => {
    expect(await run('timeout 5')).toMatchObject({
      code: 1,
      err: expect.stringContaining('missing operand'),
    });
    expect(await run('timeout foo printenv X')).toMatchObject({
      code: 1,
      err: expect.stringContaining("invalid time interval 'foo'"),
    });
  });

  it('returns exec not available when exec options are incomplete', async () => {
    const timeout = await loadTimeout(Shell);
    const result = await timeout.execute(['5', 'printenv', 'X'], {
      cwd: '/',
      env: new Map([['X', '1']]),
      stdin: '',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exec not available');
  });
});
