import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash awk -f / operand assignment patch (%s)', (_runtime, Shell) => {
  const files = {
    '/p.awk': '{ print v, $1 }\n',
    '/q.awk': 'END { print "n=" NR }\n',
    '/in': 'a\nb\n',
    '/in2': 'c\n',
  };
  const run = async (cmd: string) => {
    const r = await new Shell({ files }).exec(cmd);
    return { out: r.stdout, err: r.stderr, code: r.exitCode };
  };

  it('reads the program from -f files, separate, attached or repeated', async () => {
    expect((await run('awk -f /p.awk /in')).out).toBe(' a\n b\n');
    expect((await run('awk -f/p.awk /in')).out).toBe(' a\n b\n');
    expect((await run('awk -f /p.awk -f /q.awk /in')).out).toBe(' a\n b\nn=2\n');
    expect((await run('printf "z\\ny\\n" | awk -f /q.awk')).out).toBe('n=2\n');
    expect((await run('awk -F: -f /p.awk /in')).out).toBe(' a\n b\n');
  });

  it('applies var=value operands when they are reached', async () => {
    expect((await run('awk -f /p.awk v=1 /in v=2 /in2')).out).toBe('1 a\n1 b\n2 c\n');
    expect((await run("awk '{ print v, $1 }' v=1 /in")).out).toBe('1 a\n1 b\n');
    expect((await run('printf "x\\n" | awk -f /p.awk v=9')).out).toBe('9 x\n');
    expect((await run('awk -f /p.awk v=a\\\\tb /in2')).out).toBe('a\tb c\n');
  });

  it('keeps -v, inline programs and the error paths', async () => {
    expect((await run("awk -v v=2 '{ print v, $1 }' /in")).out).toBe('2 a\n2 b\n');
    const missing = await run('awk -f /nope.awk /in');
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("can't open file /nope.awk");
    expect((await run('awk')).err).toContain('missing program');
    expect((await run('awk "{print}" /missing')).err).toContain('/missing: No such file');
  });
});
