import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// sed prints `n`'s auto-print and `p` output in command order
// (vercel-labs/just-bash#496). Upstream 3.4.2 flushed `n` output first, so
// automake's install list (`p;s,.*/,,;n`) came out swapped and `make install`
// handed install-sh a basename.
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash sed n/p order patch (%s)', (_runtime, Shell) => {
  const sed = async (input: string, script: string) =>
    (await new Shell().exec(`printf '${input}' | sed ${script}`)).stdout;

  it("keeps automake's install-list pairs in order", async () => {
    expect(await sed('a/b\\na/b\\n', `-e 'p;s,.*/,,;n' -e 'h;s|.*|.|' -e 'p;x;s,.*/,,'`)).toBe(
      'a/b\nb\n.\nb\n'
    );
  });

  it('interleaves p, = and n as GNU and BSD sed do', async () => {
    expect(await sed('a\\nb\\nc\\n', "'p;n'")).toBe('a\na\nb\nc\nc\n');
    expect(await sed('a\\nb\\nc\\n', "'=;n'")).toBe('1\na\nb\n3\nc\n');
  });

  it('still honours -n for n', async () => {
    expect(await sed('1\\n2\\n3\\n4\\n', "-n 'p;n'")).toBe('1\n3\n');
    expect(await sed('a\\nb\\n', "-n 'n;p'")).toBe('b\n');
  });
});
