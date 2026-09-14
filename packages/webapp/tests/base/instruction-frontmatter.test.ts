import { describe, expect, it } from 'vitest';
import {
  parseFrontmatter,
  readArray,
  readBoundedTimeout,
  readOptionalString,
  splitInstructionDocument,
  validatePaths,
} from '../../src/base/instruction-frontmatter.js';

const SCHEMA = {
  arrayKeys: new Set(['paths', 'commands']),
  scalarKeys: new Set(['model', 'timeoutSeconds']),
};

describe('splitInstructionDocument', () => {
  it('splits frontmatter from body and normalizes BOM + CRLF', () => {
    const doc = splitInstructionDocument('﻿---\r\nmodel: x\r\n---\r\n\r\nDo the thing\r\n', 'X.md');
    expect(doc.frontmatter).toBe('model: x');
    expect(doc.body).toBe('Do the thing');
  });

  it('rejects a file with no prompt body, naming the file', () => {
    expect(() => splitInstructionDocument('---\nmodel: x\n---\n\n', 'GELATIERE.md')).toThrow(
      'GELATIERE.md requires frontmatter and a prompt'
    );
    expect(() => splitInstructionDocument('just prose', 'MEMORY.md')).toThrow(
      'MEMORY.md requires frontmatter and a prompt'
    );
  });
});

describe('parseFrontmatter', () => {
  it('reads inline arrays, block arrays with comment tails, and scalars', () => {
    const values = parseFrontmatter(
      [
        '# a comment line',
        'paths: [/a/, "/b, with comma/"]',
        'commands:',
        '  - cat # trailing comment',
        "  - 'quoted # not a comment'",
        'model: claude-sonnet-4-6',
        'timeoutSeconds: 30',
      ].join('\n'),
      SCHEMA
    );
    expect(values).toEqual({
      paths: ['/a/', '/b, with comma/'],
      commands: ['cat', 'quoted # not a comment'],
      model: 'claude-sonnet-4-6',
      timeoutSeconds: '30',
    });
  });

  it('rejects unknown keys, empty scalars, malformed lines, and unclosed quotes', () => {
    expect(() => parseFrontmatter('bogus: 1', SCHEMA)).toThrow('Unsupported or empty');
    expect(() => parseFrontmatter('model:', SCHEMA)).toThrow('Unsupported or empty');
    expect(() => parseFrontmatter('not a key line', SCHEMA)).toThrow('Invalid frontmatter line');
    expect(() => parseFrontmatter('paths: [/a/, "open]', SCHEMA)).toThrow('Unclosed quoted value');
    expect(() => parseFrontmatter('paths: /a/', SCHEMA)).toThrow('Expected an array');
  });
});

describe('readers', () => {
  it('readArray falls back, copies, and rejects non-arrays and empty items', () => {
    expect(readArray({}, 'paths', ['/x/'])).toEqual(['/x/']);
    expect(readArray({ paths: ['/a/'] }, 'paths', [])).toEqual(['/a/']);
    expect(() => readArray({ paths: 'nope' }, 'paths', [])).toThrow('paths is invalid');
  });

  it('readOptionalString accepts absent and non-empty strings only', () => {
    expect(readOptionalString(undefined, 'model')).toBeUndefined();
    expect(readOptionalString('m', 'model')).toBe('m');
    expect(() => readOptionalString(['m'], 'model')).toThrow('model is invalid');
  });

  it('readBoundedTimeout defaults, clamps to max, and rejects nonsense', () => {
    expect(readBoundedTimeout(undefined, 600, 1200)).toBe(600);
    expect(readBoundedTimeout('45', 600, 1200)).toBe(45);
    expect(readBoundedTimeout('99999', 600, 1200)).toBe(1200);
    expect(() => readBoundedTimeout('0', 600, 1200)).toThrow('must be positive');
    expect(() => readBoundedTimeout('soon', 600, 1200)).toThrow('must be positive');
    expect(() => readBoundedTimeout(['1'], 600, 1200)).toThrow('timeoutSeconds is invalid');
  });

  it('validatePaths wants absolute NUL-free paths and no root write grant', () => {
    expect(() => validatePaths(['/ok/'], 'visiblePaths')).not.toThrow();
    expect(() => validatePaths(['/'], 'visiblePaths')).not.toThrow();
    expect(() => validatePaths(['/'], 'writablePaths')).toThrow('absolute VFS paths');
    expect(() => validatePaths(['relative'], 'visiblePaths')).toThrow('absolute VFS paths');
    expect(() => validatePaths(['/a\0b'], 'visiblePaths')).toThrow('absolute VFS paths');
  });
});
