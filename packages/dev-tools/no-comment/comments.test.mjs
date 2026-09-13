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
    expect(isKeptComment('# shellcheck disable=SC1091')).toBe(true);
  });

  it('drops ordinary comments', () => {
    expect(isKeptComment('// TODO later')).toBe(false);
    expect(isKeptComment('/* explain the algorithm */')).toBe(false);
    expect(isKeptComment('# a yaml note')).toBe(false);
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
