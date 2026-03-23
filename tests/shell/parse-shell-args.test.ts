import { describe, it, expect } from 'vitest';
import { parseShellArgs } from './parse-shell-args.js';

describe('parseShellArgs', () => {
  it('parses simple unquoted args', () => {
    expect(parseShellArgs('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('returns empty array for empty input', () => {
    expect(parseShellArgs('')).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(parseShellArgs('   ')).toEqual([]);
  });

  it('handles single arg', () => {
    expect(parseShellArgs('hello')).toEqual(['hello']);
  });

  it('handles double-quoted strings', () => {
    expect(parseShellArgs('"foo bar"')).toEqual(['foo bar']);
  });

  it('handles double-quoted arg mixed with unquoted', () => {
    expect(parseShellArgs('hello "foo bar" baz')).toEqual(['hello', 'foo bar', 'baz']);
  });

  it('handles single-quoted strings', () => {
    expect(parseShellArgs("'foo bar'")).toEqual(['foo bar']);
  });

  it('handles single-quoted arg mixed with unquoted', () => {
    expect(parseShellArgs("hello 'foo bar' baz")).toEqual(['hello', 'foo bar', 'baz']);
  });

  it('handles escaped spaces', () => {
    expect(parseShellArgs('foo\\ bar')).toEqual(['foo bar']);
  });

  it('handles escaped space mixed with unquoted', () => {
    expect(parseShellArgs('hello foo\\ bar baz')).toEqual(['hello', 'foo bar', 'baz']);
  });

  it('handles multiple spaces between args', () => {
    expect(parseShellArgs('foo   bar   baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('handles leading and trailing whitespace', () => {
    expect(parseShellArgs('  foo bar  ')).toEqual(['foo', 'bar']);
  });

  it('handles adjacent quoted and unquoted', () => {
    expect(parseShellArgs('hello"world"')).toEqual(['helloworld']);
  });

  it('handles mixed quote types', () => {
    expect(parseShellArgs(`"double" 'single' plain`)).toEqual(['double', 'single', 'plain']);
  });
});
