import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream's `|` returned as soon as its left operand was true, leaving the
// rest of the chain unparsed, so `expr A \| B \| C` was a syntax error:
// autoconf's as_dirname / as_basename fallbacks are exactly such chains
// (vercel-labs/just-bash#500).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash expr | patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => {
    const r = await new Shell().exec(script);
    return { out: r.stdout, code: r.exitCode };
  };

  it('parses the whole chain and returns the first true operand', async () => {
    expect(await run('expr 5 \\| 6 \\| 7')).toEqual({ out: '5\n', code: 0 });
    expect(await run('expr 0 \\| "" \\| x')).toEqual({ out: 'x\n', code: 0 });
  });

  it("evaluates autoconf's as_dirname chain", async () => {
    const script =
      "expr X/a/b : 'X\\(.*[^/]\\)//*[^/][^/]*/*$' \\| X/a/b : 'X\\(//\\)[^/]' \\| X/a/b : 'X\\(//\\)$' \\| X/a/b : 'X\\(/\\)' \\| .";
    expect(await run(script)).toEqual({ out: '/a\n', code: 0 });
  });

  it('returns 0 when every operand is null or 0', async () => {
    expect(await run('expr 0 \\| ""')).toEqual({ out: '0\n', code: 1 });
    expect(await run('expr "" \\| 0')).toEqual({ out: '0\n', code: 1 });
  });
});
