import { describe, expect, it } from 'vitest';
import {
  extractSubcommandHelp,
  isHelpRequest,
  stripOptionTerminator,
  subcommandHelpText,
} from '../../../src/shell/supplemental-commands/subcommand-help.js';

const HELP = `usage: demo <verb> [args]

  list                  List things
  open <name> [--fg]    Open a thing
                        Wrapped continuation line
  route <name> --clear  Clear routing
  route                 List routes
  stop|halt <name>      Stop a thing

Notes:
  - not a verb entry lookup target
`;

describe('isHelpRequest', () => {
  it('matches --help and -h anywhere in the args', () => {
    expect(isHelpRequest(['--help'])).toBe(true);
    expect(isHelpRequest(['-h'])).toBe(true);
    expect(isHelpRequest(['name', '--flag', '--help'])).toBe(true);
  });

  it('does not match when help is absent', () => {
    expect(isHelpRequest([])).toBe(false);
    expect(isHelpRequest(['list', '--json'])).toBe(false);
    expect(isHelpRequest(['--helpful'])).toBe(false);
  });

  it("treats a value-taking flag's value as a value, not a help request", () => {
    const valueFlags = ['-append', '--send'];
    expect(isHelpRequest(['start', '-append', '--help'], { valueFlags })).toBe(false);
    expect(isHelpRequest(['serial', '--send', '-h'], { valueFlags })).toBe(false);
    // A real help flag elsewhere still counts.
    expect(isHelpRequest(['start', '-append', 'quiet', '--help'], { valueFlags })).toBe(true);
    // Without the option the value is (wrongly) read as help — this is why
    // hand-rolled parsers must declare their value flags.
    expect(isHelpRequest(['start', '-append', '--help'])).toBe(true);
  });

  it('stops at `--` so free-text payloads can contain the flag', () => {
    expect(isHelpRequest(['--', '--help'])).toBe(false);
    expect(isHelpRequest(['type', '--', '-h'])).toBe(false);
    // Before the separator it still counts.
    expect(isHelpRequest(['--help', '--', 'x'])).toBe(true);
  });
});

describe('stripOptionTerminator', () => {
  it('drops only the first `--`', () => {
    expect(stripOptionTerminator(['type', '--', '--help'])).toEqual(['type', '--help']);
    expect(stripOptionTerminator(['a', '--', 'b', '--', 'c'])).toEqual(['a', 'b', '--', 'c']);
  });

  it('is a copy when there is no separator', () => {
    expect(stripOptionTerminator(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('extractSubcommandHelp', () => {
  it('returns the entry plus its wrapped continuation lines', () => {
    const entry = extractSubcommandHelp(HELP, 'open');
    expect(entry).toContain('open <name> [--fg]');
    expect(entry).toContain('Wrapped continuation line');
    expect(entry).not.toContain('list');
  });

  it('collects every line documenting the same verb', () => {
    const entry = extractSubcommandHelp(HELP, 'route') ?? '';
    expect(entry.split('\n')).toHaveLength(2);
    expect(entry).toContain('--clear');
    expect(entry).toContain('List routes');
  });

  it('matches either side of an `a|b` alias head', () => {
    expect(extractSubcommandHelp(HELP, 'halt')).toContain('stop|halt');
  });

  it('strips a repeated command-name prefix', () => {
    const helpWithPrefix = '  demo start [opts]   Boot it\n  demo stop            Halt it\n';
    expect(extractSubcommandHelp(helpWithPrefix, 'start', { prefix: 'demo' })).toContain('Boot it');
    expect(extractSubcommandHelp(helpWithPrefix, 'start')).toBeNull();
  });

  it('returns null for an undocumented verb', () => {
    expect(extractSubcommandHelp(HELP, 'nope')).toBeNull();
    // Indented prose under a heading is not an entry head.
    expect(extractSubcommandHelp(HELP, '-')).toBeNull();
  });
});

describe('subcommandHelpText', () => {
  it('titles the extracted entry', () => {
    expect(subcommandHelpText('demo', 'list', HELP)).toBe(
      'usage: demo list\n\n  list                  List things\n'
    );
  });

  it('falls back to the full text for an unknown verb', () => {
    expect(subcommandHelpText('demo', 'nope', HELP)).toBe(HELP);
  });
});
