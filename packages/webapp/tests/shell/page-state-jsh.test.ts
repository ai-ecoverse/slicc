/**
 * Pins the bundled `page-state` helper
 * (`/workspace/skills/playwright-cli/page-state.jsh`): it composes
 * `playwright-cli eval` + `snapshot --boxes` into a viewport-filtered view
 * with a scroll summary, and marks lines that are new since the last look.
 * `exec` is faked with canned command output, so no browser is involved.
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
const PAGE_STATE_PATH = '/workspace/skills/playwright-cli/page-state.jsh';
const pageStateSource = readFileSync(
  resolve(repoRoot, 'packages/vfs-root/workspace/skills/playwright-cli/page-state.jsh'),
  'utf8'
);

function createMockFs(files: Record<string, string>): IFileSystem {
  const store = new Map<string, string>(Object.entries(files));
  const stat = async (path: string): Promise<FsStat> => {
    if (!store.has(path)) throw new Error(`ENOENT: ${path}`);
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: 0o644,
      size: (store.get(path) || '').length,
      mtime: new Date(),
    };
  };
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
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      store.set(path, (store.get(path) || '') + text);
    },
    async exists(path: string): Promise<boolean> {
      return store.has(path);
    },
    stat,
    lstat: stat,
    async mkdir(): Promise<void> {},
    async readdir(): Promise<string[]> {
      return [];
    },
    async rm(path: string): Promise<void> {
      store.delete(path);
    },
    async cp(): Promise<void> {},
    async mv(): Promise<void> {},
    resolvePath(base: string, path: string): string {
      return path.startsWith('/') ? path : `${base}/${path}`;
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
    async realpath(path: string): Promise<string> {
      return path;
    },
    async utimes(): Promise<void> {},
  };
  return fs;
}

const SNAPSHOT = `Page URL: https://shop.example/list
Page Title: Shop

- rootwebarea
  - banner
    - link "Home" [ref=e1] [box=0,10,50,20]
  - main
    - heading "Results" [ref=e2] [box=0,100,400,30]
    - list
      - listitem
        - link "Item one" [ref=e3] [box=0,200,300,20]
        - text "price 10"
      - listitem
        - link "Item far" [ref=e4] [box=0,3000,300,20]
        - text "price 99"
    - button "Hidden" [ref=e5] [box=0,0,0,0]
    - button "Load more" [ref=e6] [box=0,3100,120,30]
  - contentinfo
    - link "Imprint" [ref=e7] [box=0,3900,60,16]`;

interface Page {
  metrics: { y: number; vh: number; vw: number; h: number; ready: string };
  snapshot: string;
  fail?: { stderr: string; exitCode: number };
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function harness(page: Page) {
  const commands: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    commands.push(command);
    if (page.fail) return { stdout: '', ...page.fail };
    if (command.includes(' eval ') && command.includes('scrollBy')) {
      page.metrics.y = Math.min(page.metrics.h - page.metrics.vh, page.metrics.y + page.metrics.vh);
      return { stdout: 'ok\n', stderr: '', exitCode: 0 };
    }
    if (command.includes(' eval ')) {
      return { stdout: `${JSON.stringify(page.metrics)}\n`, stderr: '', exitCode: 0 };
    }
    if (command.includes(' snapshot ')) {
      // Fixture rects are document coordinates; --boxes reports viewport ones.
      const text = command.includes('--boxes')
        ? page.snapshot.replace(
            /\[box=(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/g,
            (_, x, y, w, h) => `[box=${x},${Number(y) - page.metrics.y},${w},${h}]`
          )
        : page.snapshot.replace(/ \[box=[^\]]*\]/g, '');
      return { stdout: `${text}\n`, stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unexpected: ${command}\n`, exitCode: 127 };
  };
  const ctx: CommandContext = {
    fs: createMockFs({ [PAGE_STATE_PATH]: pageStateSource }),
    cwd: '/workspace',
    env: new Map<string, string>([['TMPDIR', '/tmp/cone']]),
    stdin: unsafeBytesFromLatin1(''),
  };
  ctx.exec = exec as CommandContext['exec'];
  const run = (args: string[]) => executeJshFile(PAGE_STATE_PATH, args, ctx);
  return { run, commands };
}

const topOfPage = (): Page => ({
  metrics: { y: 0, vh: 800, vw: 1280, h: 4000, ready: 'complete' },
  snapshot: SNAPSHOT,
});

describe('bundled page-state.jsh', () => {
  it('shows the viewport window with live refs and a scroll summary', async () => {
    const { run, commands } = harness(topOfPage());
    const result = await run(['--tab=T1']);
    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain('URL: https://shop.example/list');
    expect(out).toContain('Scroll: 0.0 screens above, 4.0 below');
    expect(out).toContain('page-state --tab=T1 --scroll=down');
    expect(out).toContain('[Start of page]');
    expect(out).toContain('- link "Item one" [ref=e3]');
    expect(out).toContain('- text "price 10"');
    expect(out).not.toContain('Item far');
    expect(out).not.toContain('price 99');
    expect(out).not.toContain('"Hidden"');
    expect(out).not.toContain('[box=');
    expect(out).toMatch(/… \d+ snapshot lines below this window/);
    expect(out).not.toContain('[End of page]');
    expect(commands.some((c) => c.includes('snapshot --tab=T1 --boxes'))).toBe(true);
  });

  it('places an unboxed container by its children, not by the line before it', async () => {
    const { run } = harness(topOfPage());
    const out = (await run(['--tab=T1'])).stdout;
    const listitems = out.split('\n').filter((l) => l.trim() === '- listitem');
    expect(listitems).toHaveLength(1);
  });

  it('scrolls through eval, then reports the new window', async () => {
    const page = topOfPage();
    page.metrics.y = 2700;
    const { run, commands } = harness(page);
    const result = await run(['--tab=T1', '--scroll=down']);
    expect(result.exitCode).toBe(0);
    expect(commands[0]).toContain('scrollBy(0, 1 * innerHeight');
    expect(result.stdout).toContain('Scroll: 4.0 screens above, 0.0 below');
    expect(result.stdout).toContain('- link "Item far" [ref=e4]');
    expect(result.stdout).toContain('- link "Imprint" [ref=e7]');
    expect(result.stdout).toContain('[End of page]');
    expect(result.stdout).not.toContain('Item one');
    expect(result.stdout).toMatch(/… \d+ snapshot lines above this window/);
  });

  it('marks lines that appeared since the last look on the same URL', async () => {
    const page = topOfPage();
    const { run } = harness(page);
    await run(['--tab=T1']);
    page.snapshot = SNAPSHOT.replace(
      '    - heading "Results" [ref=e2] [box=0,100,400,30]',
      '    - heading "Results" [ref=e2] [box=0,100,400,30]\n    - option "Suggestion A" [ref=e9] [box=0,140,200,20]'
    );
    const out = (await run(['--tab=T1'])).stdout;
    expect(out).toContain('New since your last page-state here: 1 (marked *)');
    expect(out).toContain('*- option "Suggestion A" [ref=e9]');
    expect(out).not.toContain('*- link "Item one"');
  });

  it('prints the whole tree with --all and asks for no boxes', async () => {
    const { run, commands } = harness(topOfPage());
    const out = (await run(['--tab=T1', '--all'])).stdout;
    expect(out).toContain('Item far');
    expect(out).toContain('Imprint');
    expect(commands.some((c) => c.includes('--boxes'))).toBe(false);
  });

  it('cuts long names but keeps the ref after them', async () => {
    const page = topOfPage();
    page.snapshot = SNAPSHOT.replace('"Item one"', `"${'x'.repeat(500)}"`);
    const out = (await harness(page).run(['--tab=T1'])).stdout;
    expect(out).toContain(`"${'x'.repeat(200)}…" [ref=e3]`);
    expect(out).not.toContain('x'.repeat(201));
  });

  it('caps the tree and points at find', async () => {
    const out = (await harness(topOfPage()).run(['--tab=T1', '--max-lines=3'])).stdout;
    expect(out).toMatch(/… \d+ more lines \(narrow with: playwright-cli find --tab=T1 <text>\)/);
  });

  it('rejects a missing tab and a bad --scroll with usage', async () => {
    const noTab = await harness(topOfPage()).run([]);
    expect(noTab.exitCode).toBe(2);
    expect(noTab.stderr).toContain('--tab=<targetId> is required');
    const badScroll = await harness(topOfPage()).run(['--tab=T1', '--scroll=left']);
    expect(badScroll.exitCode).toBe(2);
    expect(badScroll.stderr).toContain('--scroll must be down or up');
  });

  it('passes a failing playwright-cli call through', async () => {
    const page = topOfPage();
    page.fail = { stderr: 'Error: No tab with id GONE\n', exitCode: 1 };
    const result = await harness(page).run(['--tab=GONE']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No tab with id GONE');
  });
});
