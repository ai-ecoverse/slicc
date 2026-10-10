import { describe, expect, it } from 'vitest';
import {
  findComments,
  isDeletedPath,
  isKeptComment,
  isProductMarkdown,
  languageForPath,
  stripSource,
} from './comments.mjs';

describe('isKeptComment', () => {
  it('keeps shebangs', () => {
    expect(isKeptComment('#!/usr/bin/env node')).toBe(true);
  });

  it('keeps TypeScript, biome, and bundler directives', () => {
    expect(isKeptComment('// @ts-expect-error hidden any')).toBe(true);
    expect(isKeptComment('// biome-ignore lint/plugin: open payload')).toBe(true);
    expect(isKeptComment('/*#__PURE__*/')).toBe(true);
    expect(isKeptComment('// unused-dep-ok: linked without import')).toBe(true);
  });

  it('keeps Go, Swift, and shell directives', () => {
    expect(isKeptComment('//go:build ignore')).toBe(true);
    expect(isKeptComment('//nolint:errcheck')).toBe(true);
    expect(isKeptComment('// swiftlint:disable:next force_cast')).toBe(true);
    expect(isKeptComment('// swift-tools-version: 5.10')).toBe(true);
    expect(isKeptComment('//export MyFunc')).toBe(true);
    expect(isKeptComment('//line foo.go:1')).toBe(true);
    expect(isKeptComment('//line foo.go:1:2')).toBe(true);
    expect(isKeptComment('# shellcheck disable=SC1091')).toBe(true);
  });

  it('drops ordinary comments', () => {
    expect(isKeptComment('// TODO later')).toBe(false);
    expect(isKeptComment('/* explain the algorithm */')).toBe(false);
    expect(isKeptComment('# a yaml note')).toBe(false);
    expect(isKeptComment('// export the helper so tests can use it')).toBe(false);
    expect(isKeptComment("// line from this secret's domains")).toBe(false);
  });
});

describe('languageForPath', () => {
  it('maps source extensions', () => {
    expect(languageForPath('packages/webapp/src/foo.ts')).toBe('js');
    expect(languageForPath('packages/webapp/src/ui.tsx')).toBe('js');
    expect(languageForPath('packages/ios-app/Foo.swift')).toBe('swift');
    expect(languageForPath('packages/slicc-cli/main.go')).toBe('go');
    expect(languageForPath('packages/slicc-cli/go.mod')).toBe('go');
    expect(languageForPath('script.sh')).toBe('hash');
    expect(languageForPath('.github/workflows/ci.yml')).toBe('hash');
    expect(languageForPath('packages/webapp/src/ui.css')).toBe('css');
    expect(languageForPath('index.html')).toBe('html');
    expect(languageForPath('biome.json')).toBe('json');
    expect(languageForPath('wrangler.jsonc')).toBe('json');
    expect(languageForPath('Makefile')).toBe('hash');
    expect(languageForPath('.gitignore')).toBe('hash');
    expect(languageForPath('packages/webapp/.gitignore')).toBe('hash');
    expect(languageForPath('.husky/pre-commit')).toBe('hash');
    expect(languageForPath('.husky/pre-push')).toBe('hash');
    expect(languageForPath('.husky/pre-merge-commit')).toBe('hash');
  });

  it('skips binaries, lockfiles, and license', () => {
    expect(languageForPath('docs/hero-banner.png')).toBeNull();
    expect(languageForPath('package-lock.json')).toBeNull();
    expect(languageForPath('LICENSE')).toBeNull();
    expect(languageForPath('packages/slicc-cli/go.sum')).toBeNull();
    expect(languageForPath('patches/foo.patch')).toBeNull();
  });
});

describe('isDeletedPath / isProductMarkdown', () => {
  it('deletes developer docs and keeps vfs-root product markdown', () => {
    expect(isDeletedPath('CLAUDE.md')).toBe(true);
    expect(isDeletedPath('packages/webapp/CLAUDE.md')).toBe(true);
    expect(isDeletedPath('packages/webapp/AGENTS.md')).toBe(true);
    expect(isDeletedPath('docs/architecture.md')).toBe(true);
    expect(isDeletedPath('.agents/skills/foo/SKILL.md')).toBe(true);
    expect(isDeletedPath('.github/copilot-instructions.md')).toBe(true);
    expect(isDeletedPath('packages/dev-tools/README.md')).toBe(true);
    expect(isDeletedPath('packages/vfs-root/shared/CLAUDE.md')).toBe(false);
    expect(isProductMarkdown('packages/vfs-root/shared/CLAUDE.md')).toBe(true);
    expect(isDeletedPath('README.md')).toBe(false);
    expect(isDeletedPath('LICENSE')).toBe(false);
    expect(isDeletedPath('packages/webapp/src/foo.ts')).toBe(false);
  });
});

describe('stripSource js', () => {
  it('removes line and block comments but keeps string contents', () => {
    const src = 'const url = "http://x.com"; // drop\nconst a = "/* not */";\n';
    const out = stripSource(src, 'js', 'a.ts');
    expect(out).not.toContain('drop');
    expect(out).toContain('"http://x.com"');
    expect(out).toContain('"/* not */"');
  });

  it('keeps shebang and @ts-expect-error', () => {
    const src = '#!/usr/bin/env node\n// @ts-expect-error known\nconst x = 1; // gone\n';
    const out = stripSource(src, 'js', 'a.mjs');
    expect(out.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(out).toContain('@ts-expect-error');
    expect(out).not.toContain('gone');
  });

  it('keeps biome-ignore directives', () => {
    const src = '// biome-ignore lint/plugin: payload\nconst x = 1;\n';
    expect(stripSource(src, 'js', 'a.ts')).toContain('biome-ignore');
  });

  it('preserves template literal text that looks like comments', () => {
    const src = 'const s = `// not a comment`;\n';
    expect(stripSource(src, 'js', 'a.ts')).toContain('`// not a comment`');
  });

  it('strips comments inside template interpolations but not template text', () => {
    const src = 'const s = `// not ${/* inner */}x`; /* block */\n';
    const out = stripSource(src, 'js', 'a.ts');
    expect(out).toContain('`// not ${');
    expect(out).toContain('}x`');
    expect(out).not.toContain('inner');
    expect(out).not.toContain('block');
  });

  it('does not treat division as a regex', () => {
    const src = 'const n = a / b; // drop\n';
    const out = stripSource(src, 'js', 'a.ts');
    expect(out).toContain('a / b');
    expect(out).not.toContain('drop');
  });

  it('keeps regex literals that look like comments', () => {
    const src = 'const r = /foo\\/bar/; // drop\nreturn /x/;\n';
    const out = stripSource(src, 'js', 'a.ts');
    expect(out).toContain('/foo\\/bar/');
    expect(out).toContain('return /x/;');
    expect(out).not.toContain('drop');
  });
});

describe('findComments js', () => {
  it('reports dropped comments with 1-based lines', () => {
    const src = 'const x = 1;\n// hello\nconst y = 2;\n';
    expect(findComments(src, 'js', 'a.ts')).toEqual([{ line: 2, text: '// hello' }]);
  });

  it('does not report comments inside strings', () => {
    expect(findComments('const s = "// nope";\n', 'js', 'a.ts')).toEqual([]);
  });
});

describe('stripSource go', () => {
  it('does not strip comments inside raw strings', () => {
    const src = 'var s = `// still data`\n// drop me\n';
    const out = stripSource(src, 'go', 'a.go');
    expect(out).toContain('`// still data`');
    expect(out).not.toContain('drop me');
  });

  it('keeps //go:build', () => {
    const src = '//go:build ignore\npackage p\n';
    expect(stripSource(src, 'go', 'a.go')).toContain('//go:build ignore');
  });
});

describe('go.mod // indirect', () => {
  const goMod = [
    'module github.com/ai-ecoverse/slicc-cli',
    '',
    'go 1.24',
    '',
    'require github.com/pkg/sftp v1.13.9 // indirect',
    '',
    'require (',
    '\tgithub.com/pion/webrtc/v4 v4.1.2',
    '\tgithub.com/pion/dtls/v3 v3.0.6 // indirect',
    '\tgithub.com/kr/fs v0.1.0 // indirect',
    ')',
    '',
  ].join('\n');

  it('allows the marker on require lines, standalone and in a block', () => {
    expect(findComments(goMod, 'go', 'go.mod')).toEqual([]);
    expect(findComments(goMod, 'go', 'packages/slicc-cli/go.mod')).toEqual([]);
    expect(stripSource(goMod, 'go', 'go.mod')).toBe(goMod);
  });

  it('allows CRLF line endings', () => {
    const crlf = goMod.replace(/\n/g, '\r\n');
    expect(findComments(crlf, 'go', 'go.mod')).toEqual([]);
    expect(stripSource(crlf, 'go', 'go.mod')).toBe(crlf);
  });

  it('still flags other go.mod comments', () => {
    const src = [
      '// Deprecated: use v2',
      'module example.com/m',
      'require example.com/a v1.0.0 // pinned for a bug',
      'require (',
      '\t// grouped deps',
      '\texample.com/b v1.0.0 //indirect',
      '\texample.com/c v1.0.0 // indirect; more',
      '\texample.com/d v1.0.0 // Indirect',
      ')',
      '',
    ].join('\n');
    expect(findComments(src, 'go', 'go.mod').map((hit) => hit.line)).toEqual([1, 3, 5, 6, 7, 8]);
  });

  it('only allows the marker on require lines', () => {
    const src = [
      'module example.com/m // indirect',
      'go 1.24 // indirect',
      'replace example.com/a v1.0.0 => example.com/b v1.0.0 // indirect',
      'exclude example.com/c v1.0.0 // indirect',
      'replace (',
      '\texample.com/d v1.0.0 // indirect',
      ')',
      'require (',
      ')',
      'example.com/e v1.0.0 // indirect',
      '// indirect',
      '',
    ].join('\n');
    expect(findComments(src, 'go', 'go.mod').map((hit) => hit.line)).toEqual([
      1, 2, 3, 4, 6, 10, 11,
    ]);
  });

  it('only applies to go.mod', () => {
    const src = 'package p\n\nvar x = 1 // indirect\n';
    expect(findComments(src, 'go', 'main.go')).toEqual([{ line: 3, text: '// indirect' }]);
    expect(stripSource(src, 'go', 'main.go')).not.toContain('indirect');
  });

  it('strips a disallowed go.mod comment but keeps the marker', () => {
    const src = 'require (\n\texample.com/a v1.0.0 // indirect\n\t// drop me\n)\n';
    const out = stripSource(src, 'go', 'go.mod');
    expect(out).toContain('example.com/a v1.0.0 // indirect');
    expect(out).not.toContain('drop me');
  });
});

describe('stripSource swift', () => {
  it('strips nested block comments', () => {
    const src = 'let x = 1 /* outer /* inner */ still */\nlet y = 2\n';
    const out = stripSource(src, 'swift', 'a.swift');
    expect(out).not.toContain('outer');
    expect(out).toContain('let x = 1');
    expect(out).toContain('let y = 2');
  });

  it('keeps swiftlint directives', () => {
    const src = '// swiftlint:disable:next force_cast\nlet x = 1\n';
    expect(stripSource(src, 'swift', 'a.swift')).toContain('swiftlint:disable:next');
  });

  it('keeps the swift-tools-version Package.swift header', () => {
    const src = '// swift-tools-version: 5.10\nimport PackageDescription\n';
    const out = stripSource(src, 'swift', 'Package.swift');
    expect(out).toContain('// swift-tools-version: 5.10');
    expect(out).toContain('import PackageDescription');
  });
});

describe('stripSource css', () => {
  it('does not treat // inside urls as comments', () => {
    const src = '.y { background: url(https://cdn.example.com/a.png) }\n';
    expect(stripSource(src, 'css', 'a.css')).toBe(src);
    expect(findComments(src, 'css', 'a.css')).toEqual([]);
  });

  it('still strips /* */ comments', () => {
    const src = '.y { color: red; /* drop */ }\n';
    const out = stripSource(src, 'css', 'a.css');
    expect(out).toContain('color: red;');
    expect(out).not.toContain('drop');
  });
});

describe('stripSource hash', () => {
  it('strips yaml comments but not hashes in quotes', () => {
    const src = 'name: foo # drop\nvalue: "bar # keep"\n';
    const out = stripSource(src, 'hash', 'a.yml');
    expect(out).not.toContain('drop');
    expect(out).toContain('"bar # keep"');
  });

  it('keeps shebang and shellcheck', () => {
    const src = '#!/usr/bin/env bash\n# shellcheck disable=SC1091\n# drop\necho hi\n';
    const out = stripSource(src, 'hash', 'a.sh');
    expect(out).toContain('#!/usr/bin/env bash');
    expect(out).toContain('shellcheck disable');
    expect(out).not.toContain('drop');
  });

  it('strips explanatory comments from husky hooks', () => {
    const src = '#!/usr/bin/env sh\n# Enforce instruction-file size budgets\nnpx lint-staged\n';
    const out = stripSource(src, 'hash', '.husky/pre-commit');
    expect(out).toContain('#!/usr/bin/env sh');
    expect(out).toContain('npx lint-staged');
    expect(out).not.toContain('Enforce instruction-file');
  });
});

describe('stripSource html', () => {
  it('strips HTML comments except prettier-ignore', () => {
    const src = '<!-- drop -->\n<!-- prettier-ignore -->\n<div></div>\n';
    const out = stripSource(src, 'html', 'a.html');
    expect(out).not.toContain('drop');
    expect(out).toContain('prettier-ignore');
  });
});

describe('stripSource json', () => {
  it('strips JSONC comments and $comment keys', () => {
    const src = `{
  "$comment": "why this exists",
  "threshold": 7.5,
  // inline
  "ok": true
}\n`;
    const out = stripSource(src, 'json', 'a.json');
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ threshold: 7.5, ok: true });
  });

  it('leaves comment-free json byte-identical', () => {
    const src = '{\n  "a": 1\n}\n';
    expect(stripSource(src, 'json', 'a.json')).toBe(src);
  });
});
