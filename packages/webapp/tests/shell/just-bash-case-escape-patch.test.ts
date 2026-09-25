import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash case escaped-pattern patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;
  const classify = (arg: string) =>
    run(
      `case ${arg} in -\\?|-h) echo usage;; --*=*) echo split;; -\\?*|-h*|-x*) echo short;; *) echo other;; esac`
    );

  it("routes libtool's options like bash", async () => {
    expect(await classify('-h')).toBe('usage\n');
    expect(await classify('"-?"')).toBe('usage\n');
    expect(await classify('-x')).toBe('short\n');
    expect(await classify('-xv')).toBe('short\n');
    expect(await classify('--mode=compile')).toBe('split\n');
    expect(await classify('--mode')).toBe('other\n');
  });

  it('keeps escaped and quoted glob characters literal', async () => {
    expect(await run('case ab in a\\*) echo bad;; a*) echo ok;; esac')).toBe('ok\n');
    expect(await run('case "a*" in a\\*) echo ok;; esac')).toBe('ok\n');
    expect(await run('case abc in "a*") echo bad;; *) echo ok;; esac')).toBe('ok\n');
    expect(await run('case "a?" in a"?") echo ok;; esac')).toBe('ok\n');
  });

  it('still globs unquoted expansions and bracket expressions', async () => {
    expect(await run('x="*"; case abc in a$x) echo ok;; esac')).toBe('ok\n');
    expect(await run('case b in [!a]) echo ok;; esac')).toBe('ok\n');
  });

  it('keeps an escaped backslash literal before a glob character (case and [[ ]])', async () => {
    const script = [
      'case "\\ab" in \\\\*) echo c1;; *) echo n1;; esac',
      'case "\\x" in \\\\?) echo c2;; *) echo n2;; esac',
      '[[ "\\ab" == \\\\* ]] && echo c3 || echo n3',
    ].join('\n');
    expect(await run(script)).toBe('c1\nc2\nc3\n');
  });
});
