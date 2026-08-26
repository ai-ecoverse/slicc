/**
 * Unit tests for the shared known-flag walk extracted from sprinkle
 * (issue #2255). Behaviour must stay aligned with `isHelpRequest`'s
 * `valueFlags` handling: the same names go in `spec.value` here and in
 * `isHelpRequest(..., { valueFlags })`.
 */

import { describe, expect, it } from 'vitest';
import { parseKnownFlags } from '../../../src/shell/supplemental-commands/subcommand-flags.js';
import { isHelpRequest } from '../../../src/shell/supplemental-commands/subcommand-help.js';

describe('parseKnownFlags', () => {
  it('collects positionals and leaves unknown dash tokens as errors', () => {
    const ok = parseKnownFlags(['name', 'payload'], {});
    expect(ok).toEqual({
      positionals: ['name', 'payload'],
      values: new Map(),
      bools: new Set(),
    });

    expect(parseKnownFlags(['--bogus=1'], {})).toEqual({ error: 'unknown flag: --bogus' });
    expect(parseKnownFlags(['name', '--nope'], {})).toEqual({ error: 'unknown flag: --nope' });
  });

  it('accepts value flags as `--flag=value` or `--flag value` in any position', () => {
    const eq = parseKnownFlags(['--runtime=leader', 'dash', '{"a":1}'], {
      value: ['--runtime'],
    });
    expect(eq).toMatchObject({
      positionals: ['dash', '{"a":1}'],
    });
    if ('error' in eq) throw new Error(eq.error);
    expect(eq.values.get('--runtime')).toBe('leader');

    const space = parseKnownFlags(['dash', '{"a":1}', '--runtime', 'leader'], {
      value: ['--runtime'],
    });
    if ('error' in space) throw new Error(space.error);
    expect(space.positionals).toEqual(['dash', '{"a":1}']);
    expect(space.values.get('--runtime')).toBe('leader');

    // Empty value after `=` is still a value (the original #2166 probe).
    const empty = parseKnownFlags(['--runtime='], { value: ['--runtime'] });
    if ('error' in empty) throw new Error(empty.error);
    expect(empty.values.get('--runtime')).toBe('');
  });

  it('requires a value when a value flag has no following token', () => {
    expect(parseKnownFlags(['--runtime'], { value: ['--runtime'] })).toEqual({
      error: '--runtime requires a value',
    });
  });

  it('accepts boolean flags in any position as exact tokens only', () => {
    const cleared = parseKnownFlags(['dash', '--clear'], { bool: ['--clear'] });
    if ('error' in cleared) throw new Error(cleared.error);
    expect(cleared.bools.has('--clear')).toBe(true);
    expect(cleared.positionals).toEqual(['dash']);

    // Attached values must not enable a boolean (e.g. `--persist=false`).
    expect(parseKnownFlags(['--clear=1'], { bool: ['--clear'] })).toEqual({
      error: 'unknown flag: --clear',
    });
    expect(parseKnownFlags(['--persist=false'], { bool: ['--persist'] })).toEqual({
      error: 'unknown flag: --persist',
    });
  });

  it('treats everything after `--` as positional, including dash tokens', () => {
    const parsed = parseKnownFlags(['send', '--', '--runtime=x', '--nope'], {
      value: ['--runtime'],
    });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.positionals).toEqual(['send', '--runtime=x', '--nope']);
    expect(parsed.values.size).toBe(0);
  });

  it('treats a bare `-` as positional, not a flag', () => {
    const parsed = parseKnownFlags(['-'], {});
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.positionals).toEqual(['-']);
  });

  it('agrees with isHelpRequest on valueFlags / spec.value names', () => {
    // Same names the sprinkle dispatcher passes to both helpers.
    const valueFlags = ['--scoop', '--runtime'] as const;
    // A --help that is the VALUE of --runtime is not a help request.
    expect(isHelpRequest(['--runtime', '--help'], { valueFlags })).toBe(false);
    const parsed = parseKnownFlags(['--runtime', '--help'], { value: valueFlags });
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.values.get('--runtime')).toBe('--help');
    // A real help flag elsewhere still counts for help, and is unknown to the
    // flag walk unless declared — callers answer help BEFORE parseKnownFlags.
    expect(isHelpRequest(['name', '--help'], { valueFlags })).toBe(true);
    expect(parseKnownFlags(['name', '--help'], { value: valueFlags })).toEqual({
      error: 'unknown flag: --help',
    });
  });
});
