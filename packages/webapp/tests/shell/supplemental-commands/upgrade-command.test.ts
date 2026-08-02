import 'fake-indexeddb/auto';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import { createUpgradeCommand } from '../../../src/shell/supplemental-commands/upgrade-command.js';

type FetchResult = Awaited<ReturnType<SecureFetch>>;
type ReleaseFiles = Record<string, string>;

const encoder = new TextEncoder();
let dbCounter = 0;

function response(url: string, body: string, status = 200): FetchResult {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: {},
    body: encoder.encode(body),
    url,
  };
}

function repoPath(path: string): string {
  return `packages/vfs-root${path}`;
}

function makeFetch(releases: Record<string, ReleaseFiles>): SecureFetch {
  return (async (url: string): Promise<FetchResult> => {
    const tree = url.match(/\/git\/trees\/([^?]+)/);
    if (tree) {
      const files = releases[decodeURIComponent(tree[1])];
      if (!files) return response(url, '', 404);
      return response(
        url,
        JSON.stringify({
          truncated: false,
          tree: Object.keys(files).map((path) => ({ path: repoPath(path), type: 'blob' })),
        })
      );
    }
    const raw = new URL(url).pathname.match(/^\/ai-ecoverse\/slicc\/([^/]+)\/(.+)$/);
    if (!raw) return response(url, '', 404);
    const ref = decodeURIComponent(raw[1]);
    const path = `/${decodeURIComponent(raw[2]).replace(/^packages\/vfs-root\//, '')}`;
    const content = releases[ref]?.[path];
    return content === undefined ? response(url, '', 404) : response(url, content);
  }) as unknown as SecureFetch;
}

async function createFs(): Promise<VirtualFS> {
  return VirtualFS.create({ dbName: `upgrade-command-${dbCounter++}`, wipe: true });
}

async function run(fs: VirtualFS, fetch: SecureFetch) {
  const result = await createUpgradeCommand({ fs, fetch }).execute(
    ['apply', '--from=1.0.0', '--to=2.0.0'],
    {} as never
  );
  return { result, json: JSON.parse(result.stdout) as any };
}

describe('upgrade apply', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await createFs();
  });

  it('is registered when VirtualFS and secure fetch are available', () => {
    const commands = createSupplementalCommands({ fs, fetch: makeFetch({}) });
    expect(commands.some((command) => command.name === 'upgrade')).toBe(true);
  });

  it('classifies and applies clean outcomes without deleting local-only files', async () => {
    const base: ReleaseFiles = {
      '/workspace/skills/auto.txt': 'base\n',
      '/workspace/skills/merge.txt': 'a\nb\nc\n',
      '/workspace/skills/local.txt': 'old upstream\n',
      '/shared/sprinkles/same.txt': 'same\n',
    };
    const next: ReleaseFiles = {
      '/workspace/skills/auto.txt': 'new\n',
      '/workspace/skills/merge.txt': 'a\nb\nC\n',
      '/shared/sprinkles/same.txt': 'same\n',
      '/shared/sounds/new.txt': 'new sound\n',
    };
    await fs.writeFile('/workspace/skills/auto.txt', 'base\n');
    await fs.writeFile('/workspace/skills/merge.txt', 'A\nb\nc\n');
    await fs.writeFile('/workspace/skills/local.txt', 'local edit\n');
    await fs.writeFile('/shared/sprinkles/same.txt', 'local edit stays\n');
    await fs.writeFile('/workspace/skills/local-only.txt', 'mine\n');

    const { result, json } = await run(fs, makeFetch({ 'v1.0.0': base, 'v2.0.0': next }));

    expect(result.exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.summary).toMatchObject({
      'auto-applied': 1,
      'merged-clean': 1,
      'kept-local': 1,
      unchanged: 1,
      'added-new': 1,
      'needs-review': 0,
    });
    expect(await fs.readFile('/workspace/skills/auto.txt')).toBe('new\n');
    expect(await fs.readFile('/workspace/skills/merge.txt')).toBe('A\nb\nC\n');
    expect(await fs.readFile('/workspace/skills/local.txt')).toBe('local edit\n');
    expect(await fs.readFile('/shared/sprinkles/same.txt')).toBe('local edit stays\n');
    expect(await fs.readFile('/shared/sounds/new.txt')).toBe('new sound\n');
    expect(await fs.readFile('/workspace/skills/local-only.txt')).toBe('mine\n');
  });

  it('writes conflicts to a collision-safe sidecar without changing the live file', async () => {
    const path = '/workspace/skills/conflict.txt';
    const existingSidecar = `${path}.upgrade-v1.0.0-to-v2.0.0.conflict`;
    await fs.writeFile(path, 'a\nlocal\nc\n');
    await fs.writeFile(existingSidecar, 'older conflict\n');

    const { result, json } = await run(
      fs,
      makeFetch({
        'v1.0.0': { [path]: 'a\nbase\nc\n' },
        'v2.0.0': { [path]: 'a\nupstream\nc\n' },
      })
    );

    expect(result.exitCode).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.results).toEqual([
      {
        path,
        status: 'needs-review',
        sidecar: `${existingSidecar}.1`,
      },
    ]);
    expect(await fs.readFile(path)).toBe('a\nlocal\nc\n');
    expect(await fs.readFile(existingSidecar)).toBe('older conflict\n');
    expect(await fs.readFile(`${existingSidecar}.1`)).toContain('<<<<<<< local:');
  });

  it('completes all remote preflight reads before making live writes', async () => {
    const good = '/workspace/skills/good.txt';
    const missing = '/workspace/skills/missing.txt';
    await fs.writeFile(good, 'base\n');
    const fetch = makeFetch({
      'v1.0.0': { [good]: 'base\n', [missing]: 'base\n' },
      'v2.0.0': { [good]: 'new\n', [missing]: 'new\n' },
    });
    const failingFetch = (async (url: string, options?: Parameters<SecureFetch>[1]) => {
      if (url.includes('v2.0.0') && url.includes('missing.txt')) return response(url, '', 503);
      return fetch(url, options);
    }) as SecureFetch;

    const { result, json } = await run(fs, failingFetch);

    expect(result.exitCode).toBe(1);
    expect(json.errors[0]).toContain('HTTP 503');
    expect(await fs.readFile(good)).toBe('base\n');
    expect(await fs.exists(missing)).toBe(false);
  });

  it('returns JSON and a nonzero exit for discovery errors', async () => {
    const { result, json } = await run(fs, makeFetch({ 'v1.0.0': {} }));
    expect(result.exitCode).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.errors[0]).toContain('HTTP 404');
  });
});
