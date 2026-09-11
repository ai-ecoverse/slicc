/**
 * Pins the bundled wiki CLI (`/workspace/skills/wiki/wiki.jsh`) against the
 * two Tier-0 regressions the memory report documented in the upstream skill:
 * a broken fs binding made `wiki stats` report `total 0` and `wiki orphans`
 * print a clean bill of health against a wiki full of orphans, with every
 * failure swallowed. The bundled script must fail loudly on a zero scan and
 * produce real counts on a real wiki.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { executeJshFile } from '../../src/shell/jsh-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const WIKI_JSH_PATH = '/workspace/skills/wiki/wiki.jsh';
const wikiJshSource = readFileSync(
  resolve(repoRoot, 'packages/vfs-root/workspace/skills/wiki/wiki.jsh'),
  'utf8'
);

/** Minimal in-memory IFileSystem (same shape as jsh-executor.test.ts's). */
function createMockFs(files: Record<string, string>): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const fs: IFileSystem = {
    async readFile(path: string): Promise<string> {
      const content = store.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async readFileBuffer(path: string): Promise<Uint8Array> {
      return new TextEncoder().encode(await fs.readFile(path));
    },
    async writeFile(path: string, content: string | Uint8Array): Promise<void> {
      store.set(path, typeof content === 'string' ? content : new TextDecoder().decode(content));
    },
    async appendFile(path: string, content: string | Uint8Array): Promise<void> {
      const existing = store.get(path) || '';
      store.set(
        path,
        existing + (typeof content === 'string' ? content : new TextDecoder().decode(content))
      );
    },
    async exists(path: string): Promise<boolean> {
      return store.has(path);
    },
    async stat(path: string): Promise<FsStat> {
      if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
      return {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mode: 0o644,
        size: (store.get(path) || '').length,
        mtime: new Date(),
      };
    },
    async mkdir(): Promise<void> {},
    async readdir(path: string): Promise<string[]> {
      const entries: string[] = [];
      const prefix = path.endsWith('/') ? path : `${path}/`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          const name = key.slice(prefix.length).split('/')[0];
          if (name && !entries.includes(name)) entries.push(name);
        }
      }
      return entries;
    },
    async rm(path: string): Promise<void> {
      store.delete(path);
    },
    async cp(): Promise<void> {},
    async mv(): Promise<void> {},
    resolvePath(base: string, path: string): string {
      if (path.startsWith('/')) return path;
      const parts = `${base}/${path}`.split('/');
      const resolved: string[] = [];
      for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p !== '.' && p !== '') resolved.push(p);
      }
      return `/${resolved.join('/')}`;
    },
    getAllPaths(): string[] {
      return [...store.keys()];
    },
    async chmod(): Promise<void> {},
    async symlink(): Promise<void> {},
    async link(): Promise<void> {},
    async readlink(): Promise<string> {
      return '';
    },
    async lstat(path: string): Promise<FsStat> {
      return fs.stat(path);
    },
    async realpath(path: string): Promise<string> {
      return path;
    },
    async utimes(): Promise<void> {},
  };
  return fs;
}

/** A small but complete wiki: 3 pages, one of them an orphan, one raw source. */
function seededWiki(): Record<string, string> {
  return {
    [WIKI_JSH_PATH]: wikiJshSource,
    '/shared/wiki/WIKI.md': '# Wiki Schema\n',
    '/shared/wiki/index.md': '# Wiki Index\n\n- [[rust-borrow-checker]] — ownership rules (tech)\n',
    '/shared/wiki/log.md':
      '# Wiki Log\n\n## [2026-09-01] ingest | rust notes\nFiled borrow checker page.\n\n## [2026-09-02] lint | link check\n0 broken links.\n',
    '/shared/wiki/tech/rust-borrow-checker.md':
      '# Rust borrow checker\n\nOwnership rules; see [[unicode-nfc]]. ([source: _raw/2026-09-01_rust-notes_ab12cd.md])\n',
    // NFC-encoded 'café' in the body: the NFD search below must still hit it.
    '/shared/wiki/tech/unicode-nfc.md':
      '# Unicode NFC\n\nNormalize filenames to NFC before comparing; caf\u00e9 counters disagree otherwise. Links back to [[rust-borrow-checker]].\n',
    '/shared/wiki/people/lars.md': '# Lars\n\nNo page links here — a deliberate orphan.\n',
    '/shared/wiki/_raw/2026-09-01_rust-notes_ab12cd.md': 'raw import, never edited\n',
  };
}

function ctxFor(files: Record<string, string>): CommandContext {
  return {
    fs: createMockFs(files),
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: unsafeBytesFromLatin1(''),
  };
}

async function runWiki(
  args: string[],
  files: Record<string, string> = seededWiki()
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return executeJshFile(WIKI_JSH_PATH, args, ctxFor(files));
}

describe('bundled wiki.jsh', () => {
  it('stats reports real counts on a populated wiki (Tier-0 regression pin)', async () => {
    const result = await runWiki(['stats']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tech');
    expect(result.stdout).toContain('people');
    expect(result.stdout).toMatch(/total\s+3/);
    expect(result.stdout).toContain('Raw source files: 1');
    expect(result.stdout).toContain('Date range: 2026-09-01 to 2026-09-01');
    expect(result.stdout).toContain('Total wikilinks: 2');
  });

  it('stats fails loudly on a zero scan instead of reporting total 0', async () => {
    const result = await runWiki(['stats'], { [WIKI_JSH_PATH]: wikiJshSource });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No wiki pages or raw source files found');
    expect(result.stdout).not.toContain('total');
  });

  it('orphans finds the planted orphan instead of a clean bill of health', async () => {
    const result = await runWiki(['orphans']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Orphan pages (1):');
    expect(result.stdout).toContain('people/lars.md');
    expect(result.stdout).not.toContain('No orphan pages found');
  });

  it('orphans errors when no pages are readable', async () => {
    const result = await runWiki(['orphans'], { [WIKI_JSH_PATH]: wikiJshSource });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No wiki pages could be read');
  });

  it('list groups pages by category and excludes index/log/_raw', async () => {
    const result = await runWiki(['list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tech/');
    expect(result.stdout).toContain('rust borrow checker  (tech/rust-borrow-checker.md)');
    expect(result.stdout).toContain('3 pages total.');
    expect(result.stdout).not.toContain('index.md');
    expect(result.stdout).not.toContain('_raw');
  });

  it('search matches content across Unicode normalization forms', async () => {
    // NFD 'café' (e + combining acute) must find the NFC 'café' in the page body.
    const result = await runWiki(['search', 'cafe\u0301']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tech/unicode-nfc.md');
    expect(result.stdout).toContain('1 result.');
  });

  it('read resolves category/name and bare names; unknown pages exit 1', async () => {
    const byPath = await runWiki(['read', 'tech/rust-borrow-checker']);
    expect(byPath.exitCode).toBe(0);
    expect(byPath.stdout).toContain('[tech/rust-borrow-checker.md]');
    expect(byPath.stdout).toContain('Ownership rules');

    const byName = await runWiki(['read', 'lars']);
    expect(byName.exitCode).toBe(0);
    expect(byName.stdout).toContain('[people/lars.md]');

    const missing = await runWiki(['read', 'no-such-page']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('Page not found');
  });

  it('links shows both directions of the tech pair', async () => {
    const result = await runWiki(['links', 'rust-borrow-checker']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Outbound (1):');
    expect(result.stdout).toContain('-> [[unicode-nfc]]');
    expect(result.stdout).toContain('Inbound (1):');
    expect(result.stdout).toContain('<- tech/unicode-nfc.md');
  });

  it('log prints the trailing entries with their keyword headings', async () => {
    const result = await runWiki(['log']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('## [2026-09-01] ingest | rust notes');
    expect(result.stdout).toContain('## [2026-09-02] lint | link check');
  });

  it('help lists the discovered categories and the wiki root', async () => {
    const result = await runWiki(['help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Categories: people, tech');
    expect(result.stdout).toContain('Wiki root:  /shared/wiki');
  });
});
