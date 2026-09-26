import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash compound pipe-stdin patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('feeds the pipe to if, for, (( ;; )) and case', async () => {
    expect(await run('echo hi | if :; then cat; fi')).toBe('hi\n');
    expect(await run('echo hi | case x in x) cat;; esac')).toBe('hi\n');
    expect(await run('printf \'a\\nb\\n\' | for i in 1 2; do read x; echo "$i$x"; done')).toBe(
      '1a\n2b\n'
    );
    expect(
      await run('printf \'a\\nb\\n\' | for ((i=0;i<2;i++)); do read x; echo "$i$x"; done')
    ).toBe('0a\n1b\n');
  });

  it('writes a config.status-shaped pipeline to its output file', async () => {
    const script =
      "printf 'X = @X@\\n' > /in; printf '{ gsub(/@X@/, \"1\"); print }' > /subs.awk; " +
      'sed "s/^/ /" /in | if :; then awk -f /subs.awk; else cat; fi > /out; cat /out';
    expect(await run(script)).toBe(' X = 1\n');
  });

  it('shares one stream between the condition and the body', async () => {
    expect(await run('printf \'a\\nb\\n\' | if read x; then read y; echo "$x$y"; fi')).toBe('ab\n');
  });

  it('leaves an inherited stream to the enclosing group', async () => {
    expect(await run('printf \'a\\nb\\n\' | { if :; then read x; fi; read y; echo "$x$y"; }')).toBe(
      'ab\n'
    );
    expect(await run('echo outer | { printf "" | if :; then cat; fi; echo "[$(cat)]"; }')).toBe(
      '[outer]\n'
    );
  });

  it('lets the compound own redirection win over the pipe', async () => {
    expect(await run('echo in > /f; echo piped | if :; then cat; fi < /f')).toBe('in\n');
  });
});
