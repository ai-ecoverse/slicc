import { describe, it, expect } from 'vitest';
import {
  hasESMImports,
  extractImportSpecifiers,
  stripCommentsAndStrings,
} from '../../../src/shell/supplemental-commands/shared.js';

describe('stripCommentsAndStrings', () => {
  it('replaces single-line comments with spaces', () => {
    const result = stripCommentsAndStrings('const x = 1; // import foo from "bar"');
    expect(result).not.toContain('import');
    expect(result).toContain('const x = 1;');
  });

  it('replaces block comments with spaces preserving newlines', () => {
    const code = 'const x = 1;\n/* import foo\nfrom "bar" */\nconst y = 2;';
    const result = stripCommentsAndStrings(code);
    expect(result).not.toContain('import');
    expect(result.split('\n').length).toBe(code.split('\n').length);
  });

  it('replaces double-quoted strings with spaces', () => {
    const result = stripCommentsAndStrings('const s = "import foo from \'bar\'"');
    expect(result).not.toContain('import foo');
  });

  it('replaces single-quoted strings with spaces', () => {
    const result = stripCommentsAndStrings("const s = 'import foo from bar'");
    expect(result).not.toContain('import foo');
  });

  it('replaces template literals with spaces', () => {
    const result = stripCommentsAndStrings('const s = `import foo from "bar"`');
    expect(result).not.toContain('import foo');
  });

  it('preserves code outside comments and strings', () => {
    const result = stripCommentsAndStrings('const x = 1; const y = 2;');
    expect(result).toBe('const x = 1; const y = 2;');
  });
});

describe('hasESMImports', () => {
  it('detects default import', () => {
    expect(hasESMImports("import foo from 'bar'")).toBe(true);
  });

  it('detects named imports', () => {
    expect(hasESMImports("import { a, b } from 'bar'")).toBe(true);
  });

  it('detects namespace import', () => {
    expect(hasESMImports("import * as foo from 'bar'")).toBe(true);
  });

  it('detects side-effect import', () => {
    expect(hasESMImports("import 'bar'")).toBe(true);
  });

  it('detects side-effect import with double quotes', () => {
    expect(hasESMImports('import "bar"')).toBe(true);
  });

  it('detects mixed default and named imports', () => {
    expect(hasESMImports("import foo, { bar } from 'baz'")).toBe(true);
  });

  it('detects mixed default and namespace imports', () => {
    expect(hasESMImports("import foo, * as bar from 'baz'")).toBe(true);
  });

  it('detects import among other code', () => {
    const code = "const x = 1;\nimport foo from 'bar';\nconsole.log(x);";
    expect(hasESMImports(code)).toBe(true);
  });

  it('returns false for dynamic import()', () => {
    expect(hasESMImports("await import('bar')")).toBe(false);
  });

  it('returns false for require()', () => {
    expect(hasESMImports("const foo = require('bar')")).toBe(false);
  });

  it('ignores imports inside single-line comments', () => {
    expect(hasESMImports("// import foo from 'bar'")).toBe(false);
  });

  it('ignores imports inside block comments', () => {
    expect(hasESMImports("/* import foo from 'bar' */")).toBe(false);
  });

  it('ignores imports inside string literals', () => {
    expect(hasESMImports('const s = "import foo from \'bar\'"')).toBe(false);
  });

  it('ignores imports inside template literals', () => {
    expect(hasESMImports("const s = `import foo from 'bar'`")).toBe(false);
  });

  it('returns false for empty code', () => {
    expect(hasESMImports('')).toBe(false);
  });

  it('returns false for code with no imports', () => {
    expect(hasESMImports('const x = 1;\nconsole.log(x);')).toBe(false);
  });

  it('detects import after semicolon on same line', () => {
    expect(hasESMImports("const x = 1; import foo from 'bar'")).toBe(true);
  });
});

describe('extractImportSpecifiers', () => {
  it('extracts specifier from default import', () => {
    expect(extractImportSpecifiers("import foo from 'bar'")).toEqual(['bar']);
  });

  it('extracts specifier from named import', () => {
    expect(extractImportSpecifiers("import { a } from 'my-lib'")).toEqual(['my-lib']);
  });

  it('extracts specifier from namespace import', () => {
    expect(extractImportSpecifiers("import * as utils from 'utils'")).toEqual(['utils']);
  });

  it('extracts specifier from side-effect import', () => {
    expect(extractImportSpecifiers("import 'side-effect'")).toEqual(['side-effect']);
  });

  it('extracts multiple specifiers from multiple imports', () => {
    const code = [
      "import foo from 'foo-lib'",
      "import { bar } from 'bar-lib'",
      "import 'init'",
    ].join('\n');
    expect(extractImportSpecifiers(code)).toEqual(['foo-lib', 'bar-lib', 'init']);
  });

  it('deduplicates specifiers', () => {
    const code = ["import foo from 'shared'", "import { bar } from 'shared'"].join('\n');
    expect(extractImportSpecifiers(code)).toEqual(['shared']);
  });

  it('returns empty array for code with no imports', () => {
    expect(extractImportSpecifiers('const x = 1;\nconsole.log(x);')).toEqual([]);
  });

  it('returns empty array for empty code', () => {
    expect(extractImportSpecifiers('')).toEqual([]);
  });

  it('ignores dynamic import specifiers', () => {
    expect(extractImportSpecifiers("const m = await import('dynamic')")).toEqual([]);
  });

  it('ignores require specifiers', () => {
    expect(extractImportSpecifiers("const m = require('cjs')")).toEqual([]);
  });

  it('ignores specifiers from commented-out imports', () => {
    const code = "// import foo from 'commented'\nimport bar from 'real'";
    expect(extractImportSpecifiers(code)).toEqual(['real']);
  });

  it('handles scoped packages', () => {
    expect(extractImportSpecifiers("import pkg from '@scope/package'")).toEqual(['@scope/package']);
  });

  it('handles relative paths', () => {
    expect(extractImportSpecifiers("import helper from './utils/helper'")).toEqual([
      './utils/helper',
    ]);
  });

  it('handles mixed default and named imports', () => {
    expect(extractImportSpecifiers("import React, { useState } from 'react'")).toEqual(['react']);
  });
});
