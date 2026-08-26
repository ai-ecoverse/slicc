import { describe, expect, it } from 'vitest';
import { playwrightHandlers } from '../../../../src/shell/supplemental-commands/playwright/handlers/index.js';
import { parseFlags } from '../../../../src/shell/supplemental-commands/playwright/state.js';
import { validateSubcommandArgs } from '../../../../src/shell/supplemental-commands/playwright/validate-args.js';

/** Validate an invocation the way the dispatcher does: parse, then check. */
function check(sub: string, args: string[]): string | null {
  const { positional } = parseFlags(args);
  return validateSubcommandArgs('playwright-cli', sub, args, positional);
}

describe('validateSubcommandArgs', () => {
  it('accepts a well-formed invocation', () => {
    expect(check('screenshot', ['--tab=t1', '--filename=/tmp/x.png'])).toBeNull();
    expect(check('click', ['e5', '--tab=t1', '--modifiers=Alt'])).toBeNull();
    expect(check('eval', ['1', '+', '1', '--tab=t1'])).toBeNull();
  });

  it('rejects a flag the subcommand does not read', () => {
    const err = check('screenshot', ['--tab=t1', '--output=/tmp/x.png']);
    expect(err).toContain('unknown flag "--output"');
    expect(err).toContain('Run "playwright-cli screenshot --help" for usage.');
  });

  it('rejects a flag another verb owns even though the parser knows it', () => {
    // `--frame` is in the shared flag table, so it parsed cleanly and was then
    // ignored by every handler that does not resolve frames.
    expect(check('screenshot', ['--tab=t1', '--frame=F1'])).toContain('unknown flag "--frame"');
  });

  it('allows --frame on the verbs that honour it', () => {
    expect(check('eval', ['document.title', '--tab=t1', '--frame=F1'])).toBeNull();
    expect(check('eval-file', ['/tmp/s.js', '--tab=t1', '--frame=F1'])).toBeNull();
    expect(check('snapshot', ['--tab=t1', '--frame=F1'])).toBeNull();
  });

  it('rejects a non-ref token in a ref slot, pointing at --filename when there is one', () => {
    const err = check('screenshot', ['/tmp/kn1.png', '--tab=t1']);
    expect(err).toContain('"/tmp/kn1.png" is not an element ref');
    expect(err).toContain('Use --filename=/tmp/kn1.png');
    // `click zzz999` already errored in the handler; it errors earlier now.
    expect(check('click', ['zzz999', '--tab=t1'])).toContain('is not an element ref');
    expect(check('drag', ['e1', 'nope', '--tab=t1'])).toContain('"nope" is not an element ref');
  });

  it('accepts main-frame and child-frame refs in a ref slot', () => {
    expect(check('hover', ['e5', '--tab=t1'])).toBeNull();
    expect(check('hover', ['f1e5', '--tab=t1'])).toBeNull();
    expect(check('drag', ['e1', 'f2e7', '--tab=t1'])).toBeNull();
  });

  it('leaves a variadic ref slot alone — `upload` takes bare file paths', () => {
    expect(check('upload', ['/a.txt', '/b.txt', '--tab=t1'])).toBeNull();
  });

  it('rejects an extra positional', () => {
    const err = check('reload', ['--tab=t1', 'extra']);
    expect(err).toContain('unexpected argument "extra"');
    expect(err).toContain('reload takes no arguments');
    expect(check('click', ['e5', 'left', 'stray', '--tab=t1'])).toContain(
      'unexpected argument "stray"'
    );
  });

  it('lets variadic verbs soak up trailing positionals', () => {
    expect(check('type', ['hello', 'there', 'world', '--tab=t1'])).toBeNull();
    expect(check('fill', ['e5', 'a', 'b', 'c', '--tab=t1'])).toBeNull();
    expect(check('localstorage-set', ['k', 'a', 'b', '--tab=t1'])).toBeNull();
    expect(check('upload', ['e5', '/a.txt', '/b.txt', '--tab=t1'])).toBeNull();
  });

  it('never mistakes a value-taking flag’s value for a flag', () => {
    expect(check('route', ['**/api', '--tab=t1', '--body', '--weird'])).toBeNull();
  });

  it('stops scanning at a `--` terminator', () => {
    expect(check('type', ['--tab=t1', '--', '--not-a-flag'])).toBeNull();
  });

  it('rejects the snapshot args the handler never wired up', () => {
    // `[target]`, `--depth` and `--boxes` were documented and parsed, but
    // `snapshotHandler` reads them into `_`-prefixed locals and drops them.
    expect(check('snapshot', ['e5', '--tab=t1'])).toContain('unexpected argument "e5"');
    expect(check('snapshot', ['--tab=t1', '--depth=2'])).toContain('unknown flag "--depth"');
    expect(check('snapshot', ['--tab=t1', '--boxes'])).toContain('unknown flag "--boxes"');
  });

  it('does not read a negative number as a flag', () => {
    // `mri` still swallows it before the handler sees it, but validation must
    // not turn that into a bogus `unknown flag "--3"`.
    expect(check('mousewheel', ['0', '-300', '--tab=t1'])).toBeNull();
  });

  it('always allows --help/-h', () => {
    expect(check('reload', ['--help'])).toBeNull();
    expect(check('reload', ['-h'])).toBeNull();
  });

  it('does not validate a verb with no manifest entry', () => {
    expect(check('not-a-real-verb', ['--whatever', 'a', 'b', 'c'])).toBeNull();
  });

  it('validates the alias verbs the dispatcher registers', () => {
    expect(check('navigate', ['https://x', '--tab=t1'])).toBeNull();
    expect(check('close', ['--tab=t1'])).toBeNull();
  });

  it('rejects --tab on the verbs that always create a new tab', () => {
    // `openHandler` serves both and never reads `flags.tab`; borrowing `open`'s
    // entry for `tab-new` would have let the ignored flag through.
    expect(check('tab-new', ['https://x', '--fg'])).toBeNull();
    expect(check('tab-new', ['https://x', '--tab=t1'])).toContain('unknown flag "--tab"');
    expect(check('open', ['https://x', '--tab=t1'])).toContain('unknown flag "--tab"');
  });

  it('takes only main-frame refs for screenshot', () => {
    // `screenshot` clips via a page-session backendNodeId, which cannot reach a
    // node inside a child frame; `click` routes through evaluateInFrame and can.
    expect(check('screenshot', ['e5', '--tab=t1'])).toBeNull();
    const err = check('screenshot', ['f1e5', '--tab=t1']);
    expect(err).toContain('"f1e5" is not an element ref');
    expect(err).toContain('main-frame ref');
    expect(check('click', ['f1e5', '--tab=t1'])).toBeNull();
  });

  it('has a spec for every registered subcommand', () => {
    // A verb with no spec is silently unvalidated — the exact hole #2405 filed.
    const unspecified = [...playwrightHandlers.keys()].filter(
      (sub) => check(sub, ['--definitely-not-a-flag']) === null
    );
    expect(unspecified).toEqual([]);
  });
});
