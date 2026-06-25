/**
 * Unit tests for the shared `parseArgs` wrapper over `mri`.
 *
 * Covers the three behaviors layered on top of mri — value-shadowing,
 * `stopEarly`, and the `--` terminator — plus the standard string/boolean/
 * alias/default plumbing the git refactor relies on.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs, parseFlagArgs } from '../../src/shell/arg-parser.js';

describe('parseArgs', () => {
  it('parses positionals and boolean flags', () => {
    const r = parseArgs(['origin', 'main', '--prune'], { boolean: ['prune'] });
    expect(r.positionals).toEqual(['origin', 'main']);
    expect(r._).toEqual(['origin', 'main']);
    expect(r.flags.prune).toBe(true);
  });

  it('treats value-flag values as strings (no number coercion)', () => {
    const r = parseArgs(['--depth', '1', 'origin', 'main'], { string: ['depth'] });
    expect(r.flags.depth).toBe('1');
    expect(r.positionals).toEqual(['origin', 'main']);
  });

  it('resolves aliases in both directions', () => {
    const spec = { string: ['format'], alias: { format: ['pretty'] } };
    expect(parseArgs(['--pretty', '%s'], spec).flags.format).toBe('%s');
    expect(parseArgs(['--format=%s'], spec).flags.pretty).toBe('%s');
  });

  it('honors --no-<flag> and boolean defaults', () => {
    const spec = { boolean: ['single-branch'], default: { 'single-branch': true } };
    expect(parseArgs([], spec).flags['single-branch']).toBe(true);
    expect(parseArgs(['--no-single-branch'], spec).flags['single-branch']).toBe(false);
  });

  describe('value-shadowing', () => {
    it('consumes a flag-looking value for a short string flag', () => {
      const r = parseArgs(['-m', '--help'], { string: ['message'], alias: { m: 'message' } });
      expect(r.flags.message).toBe('--help');
      expect(r.flags.help).toBeUndefined();
    });

    it('consumes a flag-looking value for a long string flag', () => {
      const r = parseArgs(['--grep', '--help'], { string: ['grep'] });
      expect(r.flags.grep).toBe('--help');
      expect(r.flags.help).toBeUndefined();
    });

    it('leaves inline = forms untouched', () => {
      const r = parseArgs(['--message=--help'], { string: ['message'] });
      expect(r.flags.message).toBe('--help');
    });

    it('does not shadow a value for a non-value flag', () => {
      const r = parseArgs(['--verbose', '--help'], { boolean: ['verbose', 'help'] });
      expect(r.flags.verbose).toBe(true);
      expect(r.flags.help).toBe(true);
    });
  });

  describe('stopEarly', () => {
    it('stops at the first positional, leaving the rest unparsed', () => {
      const r = parseArgs(['-c', 'a=1', 'commit', '-m', 'msg'], {
        string: ['c'],
        stopEarly: true,
      });
      expect(r.flags.c).toBe('a=1');
      expect(r.positionals).toEqual(['commit', '-m', 'msg']);
    });

    it('collects a repeated value flag as an array', () => {
      const r = parseArgs(['-c', 'a=1', '-c', 'b=2', 'status'], {
        string: ['c'],
        stopEarly: true,
      });
      expect(r.flags.c).toEqual(['a=1', 'b=2']);
      expect(r.positionals).toEqual(['status']);
    });

    it('keeps a leading value flag value out of the positionals', () => {
      const r = parseArgs(['-C', '/dir', 'status'], { string: ['C'], stopEarly: true });
      expect(r.flags.C).toBe('/dir');
      expect(r.positionals).toEqual(['status']);
    });
  });

  describe('-- terminator', () => {
    it('separates trailing tokens into doubleDashRest', () => {
      const r = parseArgs(['--', '--help'], { '--': true });
      expect(r.doubleDashRest).toEqual(['--help']);
      expect(r.positionals).toEqual([]);
      expect(r.flags.help).toBeUndefined();
    });

    it('keeps doubleDashRest empty when no terminator is present', () => {
      const r = parseArgs(['foo'], { '--': true });
      expect(r.doubleDashRest).toEqual([]);
      expect(r.positionals).toEqual(['foo']);
    });

    it('is inert when -- support is not requested', () => {
      const r = parseArgs(['a', '--', 'b']);
      expect(r.doubleDashRest).toEqual([]);
    });
  });

  it('returns an empty result for empty input', () => {
    const r = parseArgs([]);
    expect(r.positionals).toEqual([]);
    expect(r.doubleDashRest).toEqual([]);
  });
});

describe('parseFlagArgs (device-command Map/Set walk)', () => {
  const VALUE_FLAGS = new Set(['--vid', '--pid', '--timeout', '--__resolved']);

  it('splits positionals, value-flags, and boolean flags by full dash token', () => {
    const r = parseFlagArgs(['request', '--vid', '0x2e8a', '--raw'], VALUE_FLAGS);
    expect(r.positionals).toEqual(['request']);
    expect(r.flags.get('--vid')).toBe('0x2e8a');
    expect(r.bools.has('--raw')).toBe(true);
  });

  it('does not number-coerce or dash-strip value-flag values', () => {
    const r = parseFlagArgs(['--timeout', '1000'], VALUE_FLAGS);
    expect(r.flags.get('--timeout')).toBe('1000');
  });

  it('value flags consume a flag-looking next token verbatim (shadowing)', () => {
    const r = parseFlagArgs(['--vid', '--raw'], VALUE_FLAGS);
    expect(r.flags.get('--vid')).toBe('--raw');
    expect(r.bools.has('--raw')).toBe(false);
  });

  it('preserves the --__resolved gesture-bridge token and its value', () => {
    const r = parseFlagArgs(['request', '--__resolved', 'serial1'], VALUE_FLAGS);
    expect(r.flags.get('--__resolved')).toBe('serial1');
    expect(r.positionals).toEqual(['request']);
  });

  it('yields an empty string for a trailing value flag with no value', () => {
    const r = parseFlagArgs(['--vid'], VALUE_FLAGS);
    expect(r.flags.get('--vid')).toBe('');
  });

  it('returns empty collections for empty input', () => {
    const r = parseFlagArgs([], VALUE_FLAGS);
    expect(r.positionals).toEqual([]);
    expect(r.flags.size).toBe(0);
    expect(r.bools.size).toBe(0);
  });
});
