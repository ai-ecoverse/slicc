import { describe, expect, it } from 'vitest';
import { stripShebang } from '../../src/shell/strip-shebang.js';

describe('stripShebang', () => {
  it('removes only the first #! line', () => {
    expect(stripShebang('#!/usr/bin/env jsh\nconsole.log(1);\n')).toBe('console.log(1);\n');
    expect(stripShebang('console.log(1);\n')).toBe('console.log(1);\n');
    expect(stripShebang('#!/usr/bin/env jsh')).toBe('');
  });

  it('keeps a blank first line when asked so file line numbers stay put', () => {
    expect(stripShebang('#!/usr/bin/env jsh\nthrow 1;\n', { keepLine: true })).toBe('\nthrow 1;\n');
  });
});
