import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../src/ui/slash-commands.js';
import {
  createSlashCommandRegistry,
  findActiveSlashToken,
  findSkillSubmenuQuery,
} from '../../src/ui/slash-commands.js';

describe('findActiveSlashToken', () => {
  it('returns null when no slash token at cursor', () => {
    expect(findActiveSlashToken('hello', 5)).toBeNull();
    expect(findActiveSlashToken('', 0)).toBeNull();
  });
  it('matches a bare slash at start', () => {
    expect(findActiveSlashToken('/', 1)).toEqual({ prefix: '', start: 0, end: 1 });
  });
  it('matches a slash token at start', () => {
    expect(findActiveSlashToken('/sett', 5)).toEqual({ prefix: 'sett', start: 0, end: 5 });
  });
  it('matches a slash token mid-text after whitespace', () => {
    // "do xyz /sk" cursor at end (index 10)
    expect(findActiveSlashToken('do xyz /sk', 10)).toEqual({ prefix: 'sk', start: 7, end: 10 });
  });
  it('does not match a slash glued to a preceding word', () => {
    // path-like: "/workspace/skills" — the second slash is glued to "workspace"
    expect(findActiveSlashToken('/workspace/skills', 17)).toBeNull();
  });
  it('does not match when cursor is not at token end', () => {
    // cursor at index 3 in "/settings" — still inside, that's fine; but
    // a trailing space breaks the token:
    expect(findActiveSlashToken('/settings ', 10)).toBeNull();
  });
  it('matches a path-leading slash but yields a prefix that wont match commands', () => {
    // "cd /tmp" — token is /tmp, prefix 'tmp'; the registry filter handles the rest
    expect(findActiveSlashToken('cd /tmp', 7)).toEqual({ prefix: 'tmp', start: 3, end: 7 });
  });
});

describe('findSkillSubmenuQuery', () => {
  it('returns null when not in a /skills region', () => {
    expect(findSkillSubmenuQuery('/sett', 5)).toBeNull();
    expect(findSkillSubmenuQuery('/skills', 7)).toBeNull(); // no trailing space yet
  });
  it('matches /skills with empty query', () => {
    expect(findSkillSubmenuQuery('/skills ', 8)).toEqual({ query: '', start: 0, end: 8 });
  });
  it('matches /skills with a query', () => {
    expect(findSkillSubmenuQuery('/skills spr', 11)).toEqual({ query: 'spr', start: 0, end: 11 });
  });
  it('matches mid-text after whitespace', () => {
    expect(findSkillSubmenuQuery('do this /skills fr', 18)).toEqual({
      query: 'fr',
      start: 8,
      end: 18,
    });
  });
});

describe('createSlashCommandRegistry', () => {
  function fake(name: string): SlashCommand {
    return { kind: 'action', name, description: `${name} desc`, run: async () => {} };
  }

  it('list() returns commands sorted by name', () => {
    const reg = createSlashCommandRegistry([fake('skill'), fake('clear'), fake('new')]);
    expect(reg.list().map((c) => c.name)).toEqual(['clear', 'new', 'skill']);
  });
  it('get() returns command or undefined', () => {
    const reg = createSlashCommandRegistry([fake('skill')]);
    expect(reg.get('skill')?.name).toBe('skill');
    expect(reg.get('missing')).toBeUndefined();
  });
  it('match() returns commands by prefix, sorted', () => {
    const reg = createSlashCommandRegistry([fake('skill'), fake('settings'), fake('clear')]);
    expect(reg.match('s').map((c) => c.name)).toEqual(['settings', 'skill']);
    expect(reg.match('cl').map((c) => c.name)).toEqual(['clear']);
    expect(reg.match('xyz')).toEqual([]);
  });
  it('match() returns all commands for empty prefix', () => {
    const reg = createSlashCommandRegistry([fake('a'), fake('b')]);
    expect(reg.match('').map((c) => c.name)).toEqual(['a', 'b']);
  });
});
