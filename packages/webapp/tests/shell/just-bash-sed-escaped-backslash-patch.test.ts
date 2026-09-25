import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream's sed lexer collapsed `\\` in an s/// replacement to one `\`, so
// `\\\1` produced a backslash and a literal 1. config.status quotes every value
// it writes into libtool with `sed 's/\(["`$\\]\)/\\\1/g'`
// (vercel-labs/just-bash#482).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash sed escaped-backslash patch (%s)', (_runtime, Shell) => {
  const sed = async (input: string, script: string) =>
    (await new Shell({ files: { '/in': input, '/s.sed': script } }).exec('sed -f /s.sed /in'))
      .stdout;

  it('keeps a backslash before a backreference', async () => {
    expect(await sed('x\n', 's/\\(x\\)/\\\\\\1/\n')).toBe('\\x\n');
  });

  it("quotes like config.status's sed_quote_subst", async () => {
    expect(await sed('a\\(b$c"d`e\n', 's/\\(["`$\\\\]\\)/\\\\\\1/g\n')).toBe(
      'a\\\\(b\\$c\\"d\\`e\n'
    );
  });

  it('keeps the other replacement escapes', async () => {
    expect(await sed('x\n', 's/x/\\\\/\n')).toBe('\\\n');
    expect(await sed('a/b\n', 's/\\//\\\\/g\n')).toBe('a\\b\n');
    expect(await sed('ab\n', 's/a/[&]\\&/\n')).toBe('[a]&b\n');
    expect(await sed('ab\n', 's/\\(a\\)\\(b\\)/\\2\\1/\n')).toBe('ba\n');
  });
});
