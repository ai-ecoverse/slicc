import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream's script preprocessor trimmed the indentation of a line continued by
// a trailing backslash, fusing `a\<newline>    b` into `ab`. Make recipes and
// scripts indent continuation lines; libpng's awk call lost its word breaks
// (vercel-labs/just-bash#478).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash continuation-indent patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => {
    const r = await new Shell().exec(script);
    return { out: r.stdout, err: r.stderr };
  };

  it('keeps the words apart across an indented continuation', async () => {
    expect((await run('printf "[%s]\\n" a\\\n    b')).out).toBe('[a]\n[b]\n');
    expect((await run('printf "[%s]\\n" x\\\n\ty\\\n  z')).out).toBe('[x]\n[y]\n[z]\n');
    expect((await run('bash -c \'printf "[%s]\\n" a\\\n    b\'')).out).toBe('[a]\n[b]\n');
  });

  it('still joins an unindented continuation into one word', async () => {
    expect((await run('x=1\\\n2; echo $x')).out).toBe('12\n');
  });

  it('does not continue after an escaped backslash', async () => {
    const r = await run('printf "[%s]\\n" a\\\\\n    b');
    expect(r.out).toBe('[a\\]\n');
    expect(r.err).toContain('b: command not found');
  });

  it('keeps trimming ordinary indentation and heredoc bodies as before', async () => {
    expect((await run('if true; then\n    echo in\nfi')).out).toBe('in\n');
    expect((await run('cat <<EOF\n  keep\nEOF')).out).toBe('  keep\n');
  });
});
