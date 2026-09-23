/**
 * `util.parseArgs` in the realm, checked differentially against Node's own
 * implementation (vitest runs on Node): same values, positionals, tokens, and
 * the same error codes for the strict-mode failures.
 */

import { parseArgs as nodeReference } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  nodeParseArgs,
  type ParseArgsConfig,
} from '../../../src/kernel/realm/helpers/node-parse-args.js';
import { makeCtx, runScript } from './cjs-realm-harness.js';

const OPTIONS: ParseArgsConfig['options'] = {
  help: { type: 'boolean', short: 'h' },
  verbose: { type: 'boolean', short: 'v' },
  'symbols-only': { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  include: { type: 'string', short: 'I', multiple: true },
  level: { type: 'string', default: '2' },
  color: { type: 'boolean' },
};

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function same(config: ParseArgsConfig): void {
  const ours = nodeParseArgs(config);
  const theirs = nodeReference(config as Parameters<typeof nodeReference>[0]);
  expect(plain(ours)).toEqual(plain(theirs));
}

function sameError(config: ParseArgsConfig): void {
  let code: unknown;
  try {
    nodeReference(config as Parameters<typeof nodeReference>[0]);
  } catch (e) {
    code = (e as { code?: unknown }).code;
  }
  expect(code).toMatch(/^ERR_PARSE_ARGS_/);
  expect(() => nodeParseArgs(config)).toThrow(expect.objectContaining({ code }));
}

describe('util.parseArgs matches Node', () => {
  it.each([
    [['-', '--symbols-only']],
    [['settings.json', '-o', 'out.js', '--symbols-only']],
    [['--output=out.js', 'a', '--', '--not-an-option', '-x']],
    [['-vh', '-oout.js', '-I', 'a', '-Ib', '--include', 'c']],
    [['-vofile', 'pos']],
    [['-o', '-']],
    [['--level', '9', '--color']],
  ])('parses %j', (args) => {
    same({ args, options: OPTIONS, allowPositionals: true });
    same({ args, options: OPTIONS, allowPositionals: true, tokens: true });
  });

  it('keeps unknown options in non-strict mode', () => {
    same({ args: ['--foo', '--bar=baz', '-x', 'pos'], options: OPTIONS, strict: false });
    same({ args: ['--output'], options: OPTIONS, strict: false, tokens: true });
  });

  it('negates booleans with allowNegative', () => {
    same({ args: ['--no-color', '--verbose'], options: OPTIONS, allowNegative: true });
    same({ args: ['--no-color'], options: OPTIONS, allowNegative: true, tokens: true });
    // Non-strict: an undeclared --no-x negates x; a string option does not.
    same({
      args: ['--no-cache', '--no-output'],
      options: OPTIONS,
      strict: false,
      allowNegative: true,
    });
  });

  it.each([
    [{ args: ['--nope'] }],
    [{ args: ['-z'] }],
    [{ args: ['--output'] }],
    [{ args: ['--output', '--verbose'] }],
    [{ args: ['--verbose=yes'] }],
    [{ args: ['stray'] }],
    [{ args: ['--no-output'], allowNegative: true }],
    [{ args: ['--no-cache'], allowNegative: true }],
    [{ args: ['--no-color=x'], allowNegative: true }],
  ])('throws like Node for %j', (partial) => {
    sameError({ ...partial, options: OPTIONS });
  });

  it('reads the default args lazily', () => {
    const argv = ['node', '/x.js', '-o', 'a.js'];
    const parsed = nodeParseArgs({ options: OPTIONS }, () => argv.slice(2));
    expect(parsed.values.output).toBe('a.js');
  });
});

describe("require('node:util').parseArgs in the realm", () => {
  it("reads the script's own argv by default", async () => {
    const ctx = makeCtx({
      files: {
        '/workspace/cli.mjs': [
          "import { parseArgs } from 'node:util';",
          "const { values, positionals } = parseArgs({ options: { output: { type: 'string', short: 'o' } }, allowPositionals: true });",
          'console.log(values.output, positionals.join(","));',
        ].join('\n'),
      },
    });
    const r = await runScript('/workspace/cli.mjs', ctx, ['-', '-o', 'out.js', 'x']);
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('out.js -,x');
  });
});
