/**
 * What SLICC's `go` driver reads from Go sources (#3530 phase 5e), checked
 * against go/build's own rules: file-name suffixes, `//go:build` lines,
 * the header (package clause, imports, cgo, embed) and go.mod.
 */
import { describe, expect, it } from 'vitest';
import {
  evalConstraint,
  goodFileName,
  isStdPath,
  matchTag,
  minorOf,
  parseConstraint,
  parseGoMod,
  parseHeader,
} from '../../../../src/shell/supplemental-commands/go/go-source.js';

const WASI = { goos: 'wasip1', goarch: 'wasm', version: 'go1.26.5' };
const LINUX = { goos: 'linux', goarch: 'amd64', version: 'go1.26.5' };

describe('build tags', () => {
  it('match GOOS, GOARCH, gc, unix (not for wasip1), releases up to the toolchain, -tags', () => {
    expect(matchTag('wasip1', WASI)).toBe(true);
    expect(matchTag('wasm', WASI)).toBe(true);
    expect(matchTag('gc', WASI)).toBe(true);
    expect(matchTag('unix', WASI)).toBe(false);
    expect(matchTag('unix', LINUX)).toBe(true);
    expect(matchTag('cgo', LINUX)).toBe(false);
    expect(matchTag('go1.21', WASI)).toBe(true);
    expect(matchTag('go1.26', WASI)).toBe(true);
    expect(matchTag('go1.27', WASI)).toBe(false);
    expect(matchTag('linux', { ...LINUX, goos: 'android' })).toBe(true);
    expect(matchTag('purego', WASI)).toBe(false);
    expect(matchTag('purego', { ...WASI, tags: ['purego'] })).toBe(true);
    expect(minorOf('devel')).toBe(0);
  });

  it('file names: _test, _ and . files never; GOOS / GOARCH suffixes must match', () => {
    const good = (n: string, t = WASI) => goodFileName(n, t);
    expect(good('main.go')).toBe(true);
    expect(good('main_test.go')).toBe(false);
    expect(good('_skip.go')).toBe(false);
    expect(good('.hidden.go')).toBe(false);
    expect(good('main.c')).toBe(false);
    expect(good('fd_wasip1.go')).toBe(true);
    expect(good('fd_linux.go')).toBe(false);
    expect(good('fd_wasm.go')).toBe(true);
    expect(good('fd_amd64.go')).toBe(false);
    expect(good('fd_wasip1_wasm.go')).toBe(true);
    expect(good('fd_linux_amd64.go', LINUX)).toBe(true);
    expect(good('fd_linux_arm64.go', LINUX)).toBe(false);

    expect(good('linux.go')).toBe(true);
    expect(good('x_foo.go')).toBe(true);
  });

  it('//go:build expressions: !, &&, ||, parentheses; malformed ones are errors', () => {
    const ok = (e: string, t = WASI) => evalConstraint(parseConstraint(e), t);
    expect(ok('wasip1')).toBe(true);
    expect(ok('!wasip1')).toBe(false);
    expect(ok('linux || wasip1')).toBe(true);
    expect(ok('unix && !wasm')).toBe(false);
    expect(ok('unix && !wasm', LINUX)).toBe(true);
    expect(ok('(linux || darwin) && amd64', LINUX)).toBe(true);
    expect(ok('go1.18 && !(js || wasip1)')).toBe(false);
    expect(() => parseConstraint('linux &&')).toThrow(/malformed/);
    expect(() => parseConstraint('(linux')).toThrow(/malformed/);
    expect(() => parseConstraint('linux wasip1')).toThrow(/malformed/);
  });
});

describe('parseHeader', () => {
  it('reads the constraint, package and imports (grouped, named, dot, blank, raw) with positions', () => {
    const src = [
      '// Copyright notice.',
      '',
      '//go:build wasip1 || linux',
      '',
      '/* a block',
      '   comment */',
      'package main // the command',
      '',
      'import "fmt"',
      'import (',
      '\tstr "strings"',
      '\t. "math"',
      '\t_ `embed`',
      '\t"example.com/m/util" // local',
      ')',
      '',
      'func main() { fmt.Println(str.ToUpper("x"), Pi) }',
    ].join('\n');
    const h = parseHeader(src);
    expect(h.constraint).toBe('wasip1 || linux');
    expect(h.pkg).toBe('main');
    expect(h.imports).toEqual([
      { path: 'fmt', line: 9, column: 8 },
      { path: 'strings', line: 11, column: 6 },
      { path: 'math', line: 12, column: 4 },
      { path: 'embed', line: 13, column: 4 },
      { path: 'example.com/m/util', line: 14, column: 2 },
    ]);
    expect(h.embed).toBeUndefined();
  });

  it('a //go:build after code is no constraint; two are an error; //go:embed and import "C" are seen', () => {
    expect(parseHeader('package p\n//go:build linux\n').constraint).toBeUndefined();
    expect(() => parseHeader('//go:build a\n//go:build b\npackage p\n')).toThrow(/multiple/);
    const embed = parseHeader('package p\n\nimport "embed"\n\n//go:embed x.txt\nvar f embed.FS\n');
    expect(embed.embed).toEqual({ line: 5 });
    const cgo = parseHeader('package p\n\n// int x;\nimport "C"\n');
    expect(cgo.imports).toEqual([{ path: 'C', line: 4, column: 8 }]);
    expect(parseHeader('package p; import "os"; var x = 1').imports.map((i) => i.path)).toEqual([
      'os',
    ]);
    expect(parseHeader('package p\nimport "a\\"b"\n').imports[0]?.path).toBe('a"b');
  });

  it('refuses a file without a package clause or with a broken import', () => {
    expect(() => parseHeader('func main() {}')).toThrow(/package clause/);
    expect(() => parseHeader('package')).toThrow(/package name/);
    expect(() => parseHeader('package p\nimport x\n')).toThrow(/import path/);
  });
});

describe('go.mod', () => {
  it('module path, language version, requires; comments and blocks', () => {
    const m = parseGoMod(
      [
        'module "example.com/m" // the module',
        '',
        'go 1.22.3',
        'toolchain go1.26.5',
        'require github.com/x/y v1.0.0',
        'require (',
        '\tgithub.com/a/b v0.1.0 // indirect',
        ')',
        'replace (',
        '\tgithub.com/a/b => ../b',
        ')',
      ].join('\n')
    );
    expect(m).toEqual({
      module: 'example.com/m',
      goVersion: '1.22',
      requires: ['github.com/x/y', 'github.com/a/b'],
    });
    expect(parseGoMod('module m\n')).toEqual({ module: 'm', requires: [] });
    expect(() => parseGoMod('go 1.22\n')).toThrow(/no module directive/);
  });

  it('std paths have no dot in their first element', () => {
    expect(isStdPath('fmt')).toBe(true);
    expect(isStdPath('net/http')).toBe(true);
    expect(isStdPath('example.com/m')).toBe(false);
    expect(isStdPath('C')).toBe(false);
  });
});
