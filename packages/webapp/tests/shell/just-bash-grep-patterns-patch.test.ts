import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash grep patterns patch (%s)', (_runtime, Shell) => {
  const grep = async (input: string, args: string) => {
    const r = await new Shell().exec(`printf '${input}' | grep ${args}`);
    return { out: r.stdout, code: r.exitCode };
  };

  it('ORs every -e pattern, in every mode', async () => {
    expect((await grep('a\\nb\\nc\\n', '-e a -e c')).out).toBe('a\nc\n');
    expect((await grep('a\\nb\\nc\\n', '-v -e a -e b')).out).toBe('c\n');
    expect((await grep('a\\nb\\nc\\n', '-c -E -e "a|b" -e c')).out).toBe('3\n');
    expect((await grep('a.b\\naxb\\n', '-F -e x -e a.b')).out).toBe('a.b\naxb\n');
  });

  it('accepts -ePATTERN and --regexp', async () => {
    expect((await grep('a\\nb\\n', '-eb')).out).toBe('b\n');
    expect((await grep('a\\nb\\n', '--regexp=b')).out).toBe('b\n');
    expect((await grep('a\\nb\\n', '--regexp a -e b')).out).toBe('a\nb\n');
  });

  it('anchors a BRE $ that ends an alternative', async () => {
    expect((await grep('ab\\ncd\\nb$x\\n', '"b\\$\\|^c"')).out).toBe('ab\ncd\n');
    expect((await grep('a$b\\n', '"a\\$b"')).out).toBe('a$b\n');
    expect((await grep('ab\\n', '"\\(b\\$\\)"')).out).toBe('ab\n');
  });

  it("passes autoconf's AC_PROG_GREP feature check", async () => {
    const script = `
      printf %s 0123456789 > conftest.in
      n=0
      while test $n -lt 4; do
        cat conftest.in conftest.in > conftest.tmp; mv conftest.tmp conftest.in
        cp conftest.in conftest.nl; printf '%s\\n' GREP >> conftest.nl
        grep -e 'GREP$' -e '-(cannot match)-' < conftest.nl > conftest.out 2>/dev/null || break
        diff conftest.out conftest.nl > /dev/null 2>&1 || break
        n=$((n + 1))
      done
      echo $n`;
    expect((await new Shell().exec(script)).stdout).toBe('4\n');
  });
});
