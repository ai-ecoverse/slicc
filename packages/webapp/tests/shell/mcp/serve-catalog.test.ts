import { describe, expect, it } from 'vitest';
import {
  argvForCommand,
  attachGlobalFlags,
  buildTools,
  cliPrefix,
  isGroupCandidate,
  nestGroup,
  parseHelp,
  parseMcpOverride,
  parseServeArgs,
  readToolArguments,
  sanitizeName,
} from '../../../src/shell/mcp/serve-catalog.js';

const JIRA_HELP = `usage: jira <command>

Commands:
  get <issue>   Fetch one issue
  detect        Guess the site from the URL

get flags:
  --project <key>   Project key

OPTIONS:
  --json   Print JSON
`;

const SEARCH_HELP = `usage: search-console <command>

COMMANDS:
  performance   Query performance
  queries       Query list

usage: search-console performance [--property P]
usage: search-console queries [--property P]
`;

describe('parseServeArgs', () => {
  it('keeps repeatable paths and a name=path override', () => {
    const parsed = parseServeArgs([
      '--serve',
      '/workspace/skills/jira/jira.jsh',
      '--serve',
      'gh=/workspace/skills/github/scripts/gh.jsh',
    ]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.targets).toEqual([
      { path: '/workspace/skills/jira/jira.jsh' },
      { path: '/workspace/skills/github/scripts/gh.jsh', name: 'gh' },
    ]);
  });

  it('does not treat --list or --stop as a path', () => {
    expect(parseServeArgs(['--serve', '--list'])).toMatchObject({ list: true, targets: [] });
    expect(parseServeArgs(['--serve', '--stop', 'gh'])).toMatchObject({ stop: 'gh', targets: [] });
    expect(parseServeArgs(['--serve', '--stop'])).toMatchObject({ stop: true, targets: [] });
    expect(parseServeArgs(['--serve', '--help']).help).toBe(true);
  });

  it('rejects a bare argument', () => {
    expect(parseServeArgs(['--serve', 'a.jsh', 'extra']).error).toContain('unexpected argument');
  });
});

describe('parseHelp', () => {
  it('reads a Commands block, scoped flags, and leaves OPTIONS global', () => {
    const catalog = parseHelp(JIRA_HELP);
    expect(catalog.program).toBe('jira');
    const get = catalog.commands.find((command) => command.path[0] === 'get');
    expect(get?.positionals).toEqual([expect.objectContaining({ name: 'issue', required: true })]);
    expect(get?.flags.map((flag) => flag.name)).toEqual(['project']);
    expect(catalog.globalFlags.map((flag) => flag.name)).toEqual(['json']);
    expect(
      isGroupCandidate(catalog.commands.find((command) => command.path[0] === 'detect')!)
    ).toBe(true);
  });

  it('merges USAGE leaves onto the command block', () => {
    const catalog = parseHelp(SEARCH_HELP);
    const performance = catalog.commands.find((command) => command.path[0] === 'performance');
    expect(performance?.flags.map((flag) => flag.name)).toEqual(['property']);
    expect(catalog.commands.map((command) => command.path[0])).toEqual(['performance', 'queries']);
  });

  it('refuses to expand a group that reprints the top-level names', () => {
    const catalog = parseHelp(JIRA_HELP);
    const top = new Set(catalog.commands.map((command) => command.path[0] ?? ''));
    expect(nestGroup(catalog.commands, 'detect', catalog, top)).toBeNull();
  });

  it('expands a group into depth-2 tools and attaches globals afterwards', () => {
    const parent = parseHelp('usage: gh <command>\n\nCommands:\n  pr   Pull requests\n');
    const nested = parseHelp('usage: gh pr <command>\n\nCommands:\n  list   List pull requests\n');
    const top = new Set(parent.commands.map((command) => command.path[0] ?? ''));
    const expanded = nestGroup(parent.commands, 'pr', nested, top);
    expect(expanded?.map((command) => command.path)).toEqual([['pr', 'list']]);
    const withGlobal = attachGlobalFlags(expanded ?? [], [
      { name: 'json', type: 'boolean', description: '' },
    ]);
    expect(withGlobal[0]?.flags.map((flag) => flag.name)).toEqual(['json']);
    expect(isGroupCandidate(parent.commands[0]!)).toBe(true);
    expect(isGroupCandidate(withGlobal[0]!)).toBe(false);
  });
});

describe('tool argv', () => {
  it('prefixes every tool and builds spawn argv', () => {
    const catalog = parseHelp(JIRA_HELP);
    const commands = attachGlobalFlags(catalog.commands, catalog.globalFlags);
    const tools = buildTools('jira', commands);
    expect(tools.map((tool) => tool.name)).toEqual([
      'jira_help',
      'jira_invoke',
      'jira_get',
      'jira_detect',
    ]);
    const get = commands.find((command) => command.path[0] === 'get')!;
    const planned = argvForCommand(get, readToolArguments({ issue: 'PROJ-1', json: true }));
    expect(planned).toEqual({ argv: ['get', 'PROJ-1', '--json'] });
  });

  it('turns a nested command and repeatable flags into argv elements', () => {
    const command = {
      path: ['pr', 'list'],
      description: '',
      positionals: [],
      flags: [
        { name: 'state', type: 'string' as const, description: '' },
        { name: 'label', type: 'string[]' as const, description: '' },
      ],
    };
    const planned = argvForCommand(
      command,
      readToolArguments({ state: 'open', label: ['bug', 'p1'], passthrough: ['--', 'extra'] })
    );
    expect(planned).toEqual({
      argv: ['pr', 'list', '--state', 'open', '--label', 'bug', '--label', 'p1', '--', 'extra'],
    });
  });

  it('accepts a --mcp override and ignores an empty one', () => {
    const override = parseMcpOverride(
      JSON.stringify({
        commands: [{ name: 'pr list', description: 'List', positionals: [], flags: [] }],
      })
    );
    expect(override?.commands[0]?.path).toEqual(['pr', 'list']);
    expect(parseMcpOverride('{"commands":[]}')).toBeNull();
    expect(parseMcpOverride('not json')).toBeNull();
  });
});

describe('names', () => {
  it('sanitizes prefixes and prefers an explicit name', () => {
    expect(sanitizeName('Search Console')).toBe('search_console');
    expect(sanitizeName('---')).toBe('cli');
    expect(cliPrefix('usage: jira <command>', '/workspace/jira.jsh')).toBe('jira');
    expect(cliPrefix('', '/workspace/skills/github/scripts/gh.jsh', 'Hub')).toBe('hub');
  });
});
