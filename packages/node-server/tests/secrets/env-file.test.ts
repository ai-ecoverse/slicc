import { describe, expect, it } from 'vitest';
import { parseEnvFile, serializeEnvFile } from '../../src/secrets/env-file.js';

describe('parseEnvFile', () => {
  it('parses simple KEY=VALUE lines', () => {
    const content = 'FOO=bar\nBAZ=qux\n';
    expect(parseEnvFile(content)).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('skips blank lines and comments', () => {
    const content = '# comment\n\nFOO=bar\n\n# another\nBAZ=qux\n';
    expect(parseEnvFile(content)).toEqual([
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ]);
  });

  it('strips double quotes from values', () => {
    expect(parseEnvFile('KEY="hello world"')).toEqual([{ key: 'KEY', value: 'hello world' }]);
  });

  it('strips single quotes from values', () => {
    expect(parseEnvFile("KEY='hello world'")).toEqual([{ key: 'KEY', value: 'hello world' }]);
  });

  it('handles values containing = signs', () => {
    expect(parseEnvFile('KEY=abc=def=ghi')).toEqual([{ key: 'KEY', value: 'abc=def=ghi' }]);
  });

  it('handles empty values', () => {
    expect(parseEnvFile('KEY=')).toEqual([{ key: 'KEY', value: '' }]);
  });

  it('skips lines without =', () => {
    expect(parseEnvFile('MALFORMED\nKEY=val')).toEqual([{ key: 'KEY', value: 'val' }]);
  });

  it('trims whitespace around keys and values', () => {
    expect(parseEnvFile('  KEY  =  value  ')).toEqual([{ key: 'KEY', value: 'value' }]);
  });
});

describe('serializeEnvFile', () => {
  it('serializes entries to KEY=VALUE format', () => {
    const result = serializeEnvFile([
      { key: 'A', value: 'one' },
      { key: 'B', value: 'two' },
    ]);
    expect(result).toBe('A=one\nB=two\n');
  });

  it('quotes values with spaces', () => {
    const result = serializeEnvFile([{ key: 'K', value: 'hello world' }]);
    expect(result).toBe('K="hello world"\n');
  });

  it('quotes values with # characters', () => {
    const result = serializeEnvFile([{ key: 'K', value: 'val#comment' }]);
    expect(result).toBe('K="val#comment"\n');
  });

  it('round-trips parsed content', () => {
    const original = 'FOO=bar\nBAZ=qux\n';
    const parsed = parseEnvFile(original);
    expect(serializeEnvFile(parsed)).toBe(original);
  });
});
