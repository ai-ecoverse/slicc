import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash case bracket patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => (await new Shell().exec(script)).stdout;

  it('negates with [!...] (and still [^...])', async () => {
    expect(await run('case x in [!_a]) echo neg;; esac')).toBe('neg\n');
    expect(await run('case b in [^a]) echo caret;; esac')).toBe('caret\n');
    expect(await run('[[ b == [!a] ]] && echo dbl')).toBe('dbl\n');
  });

  it("accepts autoconf's variable-name check", async () => {
    const check = (name: string) =>
      `as_cr_alnum=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789; case ${name} in '' | [0-9]* | *[!_$as_cr_alnum]* ) echo invalid;; *) echo valid;; esac`;
    expect(await run(check('CPPFLAGS'))).toBe('valid\n');
    expect(await run(check('ac_cv_x'))).toBe('valid\n');
    expect(await run(check('bad-name'))).toBe('invalid\n');
    expect(await run(check('9lives'))).toBe('invalid\n');
  });

  it('handles ] first, named classes and escapes like bash', async () => {
    expect(await run('case "]" in []]) echo rb;; esac')).toBe('rb\n');
    expect(await run('case a in [!]]) echo notrb;; esac')).toBe('notrb\n');
    expect(await run('case Q in [[:upper:]]) echo up;; esac')).toBe('up\n');
    expect(await run('case 7 in [[:alpha:]]) echo al;; *) echo notal;; esac')).toBe('notal\n');
    expect(await run('case x in [) echo lit;; *) echo other;; esac')).toBe('other\n');
  });
});
