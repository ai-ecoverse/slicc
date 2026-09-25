import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash exec replaces the shell patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => {
    const r = await new Shell().exec(script);
    return { out: r.stdout, code: r.exitCode };
  };

  it('ends the script with the command status', async () => {
    expect(await run("echo x; exec sh -c 'exit 4'; echo after")).toEqual({ out: 'x\n', code: 4 });
    expect(await run('exec echo hi; echo after')).toEqual({ out: 'hi\n', code: 0 });
  });

  it("stops libtool's install mode at the finish exec", async () => {
    const script = `exec_cmd='echo finish "a b"'; eval exec "$exec_cmd"; exit 1`;
    expect(await run(script)).toEqual({ out: 'finish a b\n', code: 0 });
  });

  it('ends only the subshell or function body it runs in', async () => {
    expect((await run("(exec sh -c 'exit 3'); echo rc=$?")).out).toBe('rc=3\n');
    expect((await run('x=$(exec echo sub); echo "got $x"')).out).toBe('got sub\n');
  });

  it('keeps a redirection-only exec running the script', async () => {
    expect((await run('exec </dev/null; echo still')).out).toBe('still\n');
  });
});
