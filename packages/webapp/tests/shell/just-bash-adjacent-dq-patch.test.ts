import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash adjacent double quotes patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('ends a variable name at the closing quote', async () => {
    expect(await run('x=AB; x_y=Q; echo "$x""_y"')).toBe('AB_y\n');
    expect(await run('x=AB; echo "a $x""_c"')).toBe('a AB_c\n');
  });

  it("builds AX_PREFIX_CONFIG_H's sed command", async () => {
    const script = String.raw`p=MAGICKCORE; printf '%s\n' "s/^#undef  *\\([A-Z_]\\)/#undef $p""_\\1/"`;
    expect(await run(script)).toBe(String.raw`s/^#undef  *\([A-Z_]\)/#undef MAGICKCORE_\1/` + '\n');
  });

  it('still joins plain adjacent segments into one word', async () => {
    expect(await run(`echo "a""b" "a b""c d" "q"'x'`)).toBe('ab a bc d qx\n');
    expect(await run("printf '%s|' \"a\"\"b\" 'c''d'")).toBe('ab|cd|');
  });
});
