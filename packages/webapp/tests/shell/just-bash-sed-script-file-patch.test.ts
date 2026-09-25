import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// `sed -f` passes the whole script file to the parser, as `-e` does
// (vercel-labs/just-bash#492). Upstream 3.4.2 split it into trimmed lines and
// dropped every line starting with `#`, so autoconf's AX_PREFIX_CONFIG_H
// script (a multi-line s/// replacement whose continuation lines start with
// `#define` / `#endif`) produced an empty ImageMagick magick-baseconfig.h.
const PREFIX_SCRIPT = [
  String.raw`s/^#undef  *\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_]\)/#undef P_\1/`,
  String.raw`s/^#define  *\([ABCDEFGHIJKLMNOPQRSTUVWXYZ_][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*\)\(.*\)/#ifndef P_\1\ `.trimEnd(),
  String.raw`#define P_\1\2\ `.trimEnd(),
  '#endif/',
  '',
].join('\n');

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash sed -f script file patch (%s)', (_runtime, Shell) => {
  const sed = async (script: string, input: string, args = '-f /s.sed') =>
    (await new Shell({ files: { '/s.sed': script, '/in': input } }).exec(`sed ${args} /in`)).stdout;

  it("joins a multi-line replacement whose lines start with '#' (AX_PREFIX_CONFIG_H)", async () => {
    expect(await sed(PREFIX_SCRIPT, '/* c */\n#define HAVE_X 1\n#undef FOO\n')).toBe(
      '/* c */\n#ifndef P_HAVE_X\n#define P_HAVE_X 1\n#endif\n#undef P_FOO\n'
    );
  });

  it('keeps comments, #n and blank lines working', async () => {
    expect(await sed('#n\n# a comment\n\n  /b/p\ns/x/Y/\n', 'a\nbx\n')).toBe('bx\n');
  });

  it('keeps the indentation of a\\ text', async () => {
    expect(await sed('1a\\\n   indented\n', 'l1\n')).toBe('l1\n   indented\n');
  });

  it('combines with -e scripts in order', async () => {
    expect(await sed('s/l/L/\n', 'l1\n', "-e 's/1/2/' -f /s.sed")).toBe('L2\n');
  });
});
