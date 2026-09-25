import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash leading-IFS word split patch (%s)', (_runtime, Shell) => {
  const args = async (script: string) =>
    (await new Shell().exec(`${script}; printf '[%s]' "$@"`)).stdout;

  it('breaks after a literal when the expansion starts with a delimiter', async () => {
    expect(await args('x=" /lib"; set -- --finish$x')).toBe('[--finish][/lib]');
    expect(await args('x=" a b"; set -- pre${x}post')).toBe('[pre][a][bpost]');
    expect(await args('IFS=:; x=":a"; set -- pre$x')).toBe('[pre][a]');
  });

  it('breaks between adjacent expansions around a delimiter', async () => {
    expect(await args('a="x "; b=y; set -- $a$b')).toBe('[x][y]');
    expect(await args('a=x; b=" y"; set -- $a$b')).toBe('[x][y]');
  });

  it("runs libtool's --finish idiom", async () => {
    const script =
      'current_libdirs=; current_libdirs+=" /usr/lib"; f() { printf "[%s]" "$@"; }; eval \'f --finish$current_libdirs\'';
    expect((await new Shell().exec(script)).stdout).toBe('[--finish][/usr/lib]');
  });

  it('keeps words without a leading delimiter joined', async () => {
    expect(await args('x="a b "; set -- pre$x')).toBe('[prea][b]');
    expect(await args('x=" "; set -- pre$x')).toBe('[pre]');
  });
});
