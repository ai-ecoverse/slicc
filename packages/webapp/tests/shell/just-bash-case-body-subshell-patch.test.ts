import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash case-body subshell patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => {
    const r = await new Shell().exec(script);
    return { out: r.stdout, err: r.stderr };
  };

  it('parses a subshell starting with an expansion inside a case item', async () => {
    expect((await run('x=echo; case a in a)\n( $x hi )\n;; esac')).out).toBe('hi\n');
    expect((await run('x=true; case a in a)\n( $x )\n;; esac; echo rc=$?')).out).toBe('rc=0\n');
  });

  it("runs autoconf's header-check warning block", async () => {
    const script =
      'as_echo=echo; as_me=configure; case no:yes: in #((\n  no:yes:* )\n' +
      '( $as_echo "## -- ##\n## Report this ##"\n     ) | sed "s/^/$as_me: W: /"\n    ;;\nesac';
    expect((await run(script)).out).toBe(
      'configure: W: ## -- ##\nconfigure: W: ## Report this ##\n'
    );
  });

  it('still rejects a pattern-shaped group followed by a word', async () => {
    const r = await run('case a in a) echo x\n("$y") echo y;; esac');
    expect(r.err).toContain('syntax error');
  });
});
