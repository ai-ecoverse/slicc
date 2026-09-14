import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main as checkMain, formatReport } from './check.mjs';
import { applyStrip, checkTree, isNoCommentTree, NO_COMMENT_MARKER, STUB_README } from './lib.mjs';
import { parseArgs, main as stripMain } from './strip.mjs';

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), '..', '..', '..');
const fixtures = [];

function createTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'no-comment-'));
  fixtures.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, files: Object.keys(files) };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('applyStrip', () => {
  it('strips comments, deletes docs, writes the marker and stub README', () => {
    const { root, files } = createTree({
      'src/app.ts': 'const x = 1; // drop\n',
      'CLAUDE.md': '# docs\n',
      'docs/architecture.md': '# arch\n',
      'packages/vfs-root/shared/CLAUDE.md': '# keep product\n',
      LICENSE: 'Apache-2.0\n',
    });
    const stats = applyStrip(root, files);
    expect(stats.stripped).toBeGreaterThanOrEqual(1);
    expect(stats.deleted).toBeGreaterThanOrEqual(2);
    expect(isNoCommentTree(root)).toBe(true);
    expect(readFileSync(join(root, 'src/app.ts'), 'utf8')).not.toContain('drop');
    expect(readFileSync(join(root, 'src/app.ts'), 'utf8')).toContain('const x = 1;');
    expect(() => readFileSync(join(root, 'CLAUDE.md'))).toThrow();
    expect(() => readFileSync(join(root, 'docs/architecture.md'))).toThrow();
    expect(readFileSync(join(root, 'packages/vfs-root/shared/CLAUDE.md'), 'utf8')).toContain(
      'keep product'
    );
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toBe('Apache-2.0\n');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(STUB_README);
    expect(readFileSync(join(root, NO_COMMENT_MARKER), 'utf8')).toBe('');
  });
});

describe('checkTree', () => {
  it('is inactive without the marker', () => {
    const { root, files } = createTree({ 'src/app.ts': 'const x = 1; // comment\n' });
    expect(checkTree(root, { files })).toEqual({ inactive: true, hits: [], forbidden: [] });
  });

  it('reports leftover comments and forbidden docs when forced', () => {
    const { root, files } = createTree({
      'src/app.ts': 'const x = 1; // leftover\n',
      'CLAUDE.md': '# no\n',
    });
    const result = checkTree(root, { requireMarker: false, files });
    expect(result.inactive).toBe(false);
    expect(result.forbidden).toContain('CLAUDE.md');
    expect(
      result.hits.some((hit) => hit.file === 'src/app.ts' && hit.text.includes('leftover'))
    ).toBe(true);
  });

  it('passes a stripped tree', () => {
    const { root, files } = createTree({
      'src/app.ts': 'const x = 1; // drop\n',
      'CLAUDE.md': '# docs\n',
    });
    applyStrip(root, files);
    const remaining = [...files, NO_COMMENT_MARKER, 'README.md'].filter((rel) =>
      existsSync(join(root, rel))
    );
    const result = checkTree(root, { files: remaining });
    expect(result.inactive).toBe(false);
    expect(result.hits).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });
});

describe('formatReport', () => {
  it('describes inactivity, success, and failures', () => {
    expect(formatReport({ inactive: true, hits: [], forbidden: [] })).toContain('inactive');
    expect(formatReport({ inactive: false, hits: [], forbidden: [] })).toContain('ok: no comments');
    expect(
      formatReport({
        inactive: false,
        hits: [{ file: 'a.ts', line: 3, text: '// x' }],
        forbidden: ['CLAUDE.md'],
      })
    ).toContain('CLAUDE.md: documentation file is not allowed');
  });
});

describe('CLI helpers', () => {
  it('parseArgs reads --root', () => {
    expect(parseArgs(['--root', '/tmp/foo']).root).toBe(resolve('/tmp/foo'));
  });

  it('strip --help exits 0', () => {
    expect(stripMain(['--help'])).toBe(0);
  });

  it('check --help exits 0', () => {
    expect(checkMain(['--help'])).toBe(0);
  });
});

describe('lint wiring', () => {
  it('package.json lint scripts include lint:no-comments', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['lint:no-comments']).toBe('node packages/dev-tools/no-comment/check.mjs');
    expect(pkg.scripts.lint).toContain('lint:no-comments');
    expect(pkg.scripts['lint:ci']).toContain('lint:no-comments');
  });

  it('pre-push gate and pre-commit hook invoke the check', () => {
    const prePush = readFileSync(
      join(repoRoot, 'packages/dev-tools/tools/pre-push-lint-gate.sh'),
      'utf8'
    );
    const preCommit = readFileSync(join(repoRoot, '.husky/pre-commit'), 'utf8');
    expect(prePush).toContain('lint:no-comments');
    expect(preCommit).toContain('packages/dev-tools/no-comment/check.mjs');
  });

  it('the mirror workflow runs on pushes to main', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/no-comment-mirror.yml'), 'utf8');
    expect(yml).toContain('branches: [main]');
    expect(yml).toContain('refs/heads/no-comment');
    expect(yml).toContain('packages/dev-tools/no-comment/strip.mjs');
  });
});
