import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream decoded only \n \t \r, so `tr X '\015'` printed `0`. autoconf's
// config.status computes its carriage return that way and then strips
// `$ac_cr` from its awk program: every trailing 0 vanished and config.status
// failed with "could not create Makefile" (vercel-labs/just-bash#476).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash tr escape patch (%s)', (_runtime, Shell) => {
  const run = async (cmd: string) => (await new Shell().exec(cmd)).stdout;
  const codes = (s: string) => [...s].map((c) => c.charCodeAt(0));

  it('decodes octal escapes', async () => {
    expect(codes(await run("echo X | tr X '\\015'"))).toEqual([13, 10]);
    expect(await run("echo abc | tr b '\\101'")).toBe('aAc\n');
    expect(await run("printf 'a\\tb\\n' | tr '\\11' ' '")).toBe('a b\n');
  });

  it('decodes the other POSIX escapes', async () => {
    expect(codes(await run("printf 'a' | tr a '\\a'"))).toEqual([7]);
    expect(codes(await run("printf 'abc' | tr abc '\\b\\f\\v'"))).toEqual([8, 12, 11]);
    expect(await run("printf 'a\\\\b' | tr '\\\\' /")).toBe('a/b');
  });

  it('takes escaped range endpoints', async () => {
    expect(await run("printf 'a\\001b\\037c\\n' | tr -d '\\000-\\037'")).toBe('abc');
  });

  it("gives autoconf's ac_cr a carriage return", async () => {
    const script = "ac_cr=`echo X | tr X '\\015'`; printf 'substed = 0\\n' | sed \"s/$ac_cr\\$//\"";
    expect(await run(script)).toBe('substed = 0\n');
  });

  it('keeps plain sets and ranges', async () => {
    expect(await run('echo hello | tr a-z A-Z')).toBe('HELLO\n');
    expect(await run("echo 'a b' | tr -d ' '")).toBe('ab\n');
  });
});
