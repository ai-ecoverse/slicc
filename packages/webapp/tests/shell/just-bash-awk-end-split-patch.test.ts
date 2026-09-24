import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Two upstream awk bugs that together kept libpng's scripts/options.awk from
// generating pnglibconf.h:
// - a `next` on the last record left its flag set and END ran one statement
//   (vercel-labs/just-bash#483);
// - split("") returned 1 and whitespace splits kept leading/trailing empty
//   fields, so empty dependency lists had a phantom "" entry
//   (vercel-labs/just-bash#484).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash awk END / split patch (%s)', (_runtime, Shell) => {
  const awk = async (program: string, input = 'a\nb\n') => {
    const r = await new Shell({ files: { '/p.awk': program, '/in': input } }).exec(
      'awk -f /p.awk /in'
    );
    return r.stdout;
  };

  it('runs the whole END block after a next on the last record', async () => {
    expect(await awk('{ next }\nEND { print "E1"; print "E2" }\n')).toBe('E1\nE2\n');
    expect(await awk('{ nextfile }\nEND { print NR; print "E2" }\n')).toBe('1\nE2\n');
  });

  it('keeps exit in END working', async () => {
    expect(await awk('END { print "E1"; exit; print "never" }\n')).toBe('E1\n');
  });

  it('returns no fields for an empty string', async () => {
    expect(
      await awk('BEGIN { print split("", a); print split("", a, ","); print length(a) }\n')
    ).toBe('0\n0\n0\n');
  });

  it('ignores leading and trailing blanks in whitespace mode', async () => {
    expect(
      await awk('BEGIN { print split("  ", a); n = split(" a  b ", a); print n, a[1], a[2] }\n')
    ).toBe('0\n2 a b\n');
    expect(await awk('BEGIN { print split(" x ", a, " ") }\n')).toBe('1\n');
  });

  it('keeps empty fields for explicit separators', async () => {
    expect(await awk('BEGIN { print split("a,,b", a, ","); print split(",", a, ",") }\n')).toBe(
      '3\n2\n'
    );
  });
});
