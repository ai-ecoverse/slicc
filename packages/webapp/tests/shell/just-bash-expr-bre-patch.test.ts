import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash expr BRE patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('returns the \\( \\) capture, as autoconf relies on', async () => {
    expect(await run(`expr "xCPPFLAGS=-I/z" : 'x\\([^=]*\\)='`)).toBe('CPPFLAGS\n');
    expect(await run(`expr "x--host=wasm" : 'x[^=]*=\\(.*\\)'`)).toBe('wasm\n');
    expect(await run(`expr match "abc" 'a\\(b\\)'`)).toBe('b\n');
  });

  it('keeps match lengths, and treats bare ( ) { } + as literals', async () => {
    expect(await run('expr "abc" : "ab"')).toBe('2\n');
    expect(await run('expr "a(b)" : "a(b)"')).toBe('4\n');
    expect(await run(`expr "aaa" : 'a\\{2\\}'`)).toBe('2\n');
    expect(await run('expr "a+b" : "a+b"')).toBe('3\n');
  });

  it('reports no match as 0 with exit status 1', async () => {
    const r = await new Shell().exec('expr "abc" : "b"');
    expect(r.stdout).toBe('0\n');
    expect(r.exitCode).toBe(1);
  });
});
