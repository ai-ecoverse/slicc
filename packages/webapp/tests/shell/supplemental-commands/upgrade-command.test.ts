import 'fake-indexeddb/auto';
import type { SecureFetch } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  // #2195: policy files under /etc are seeded only when absent, so a rule added
  // to the shipped template (e.g. the `Write /etc/models` gate) reaches an
  // existing profile ONLY through this merge.
  it('carries an /etc policy-file change to a profile that already has one', async () => {
    const base = '# sudoers\n# example\n';
    const upstream = '# sudoers\nWrite /etc/models\n# example\n';
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile('/etc/sudoers', base);

    const { result, json } = await run(
      fs,
      makeFetch({
        'v1.0.0': { '/etc/sudoers': base },
        'v2.0.0': { '/etc/sudoers': upstream, '/etc/models': '# model policy\n' },
      })
    );

    expect(result.exitCode).toBe(0);
    expect(json.ok).toBe(true);
    expect(await fs.readFile('/etc/sudoers')).toBe(upstream);
    // A policy file the profile never had arrives too.
    expect(await fs.readFile('/etc/models')).toBe('# model policy\n');
  });

  it('keeps a locally edited /etc policy file when upstream did not move', async () => {
    const shipped = '# sudoers\nWrite /etc/models\n';
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile('/etc/sudoers', '# sudoers\n# my own policy\n');

    const { json } = await run(
      fs,
      makeFetch({ 'v1.0.0': { '/etc/sudoers': shipped }, 'v2.0.0': { '/etc/sudoers': shipped } })
    );

    // Upstream did not move, so there is nothing to deliver — the local edit
    // stands (classified `unchanged`, not overwritten with the template).
    expect(json.summary.unchanged).toBe(1);
    expect(await fs.readFile('/etc/sudoers')).toBe('# sudoers\n# my own policy\n');
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

  it('rolls back earlier writes when a later write fails', async () => {
    const first = '/workspace/skills/first.txt';
    const second = '/workspace/skills/second.txt';
    await fs.writeFile(first, 'first base\n');
    await fs.writeFile(second, 'second base\n');
    const writeFile = fs.writeFile.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (path, content, options) => {
      if (path === second && !failed) {
        failed = true;
        throw new Error('disk full');
      }
      await writeFile(path, content, options);
    });

    const { result, json } = await run(
      fs,
      makeFetch({
        'v1.0.0': { [first]: 'first base\n', [second]: 'second base\n' },
        'v2.0.0': { [first]: 'first next\n', [second]: 'second next\n' },
      })
    );

    expect(result.exitCode).toBe(1);
    expect(json.errors[0]).toContain(
      `apply failed for ${second}: disk full; all writes rolled back`
    );
    expect(await fs.readFile(first)).toBe('first base\n');
    expect(await fs.readFile(second)).toBe('second base\n');
  });

  // `/shared/MEMORY.md` is the memory-curator contract. It is seeded only when
  // absent, so this merge is the only route by which a curator-rule change
  // reaches a workspace that already has one.
  it('merges the curator contract at /shared/MEMORY.md while keeping local edits', async () => {
    const path = '/shared/MEMORY.md';
    await fs.writeFile(path, 'intro\nlocal rule\noutro\n');

    const { result, json } = await run(
      fs,
      makeFetch({
        'v1.0.0': { [path]: 'intro\nbase rule\noutro\n' },
        'v2.0.0': { [path]: 'intro\nbase rule\noutro\nupstream rule\n' },
      })
    );

    expect(result.exitCode).toBe(0);
    expect(json.results).toEqual([{ path, status: 'merged-clean' }]);
    expect(await fs.readFile(path)).toBe('intro\nlocal rule\noutro\nupstream rule\n');
  });

  it('ignores bundled files outside the upgrade scopes', async () => {
    const path = '/shared/CLAUDE.md';
    await fs.writeFile(path, 'local\n');

    const { json } = await run(
      fs,
      makeFetch({ 'v1.0.0': { [path]: 'base\n' }, 'v2.0.0': { [path]: 'upstream\n' } })
    );

    expect(json.results).toEqual([]);
    expect(await fs.readFile(path)).toBe('local\n');
  });

  it('returns JSON and a nonzero exit for discovery errors', async () => {
    const { result, json } = await run(fs, makeFetch({ 'v1.0.0': {} }));
    expect(result.exitCode).toBe(1);
    expect(json.ok).toBe(false);
    expect(json.errors[0]).toContain('HTTP 404');
  });

  it('returns JSON and a nonzero exit when a GitHub request times out', async () => {
    vi.useFakeTimers();
    try {
      const fetch = makeFetch({ 'v1.0.0': {}, 'v2.0.0': {} });
      const hangingFetch = (async (url: string, options?: Parameters<SecureFetch>[1]) => {
        if (url.includes('/git/trees/v2.0.0')) return new Promise<never>(() => undefined);
        return fetch(url, options);
      }) as SecureFetch;

      const pending = run(fs, hangingFetch);
      await vi.advanceTimersByTimeAsync(30_000);
      const { result, json } = await pending;

      expect(result.exitCode).toBe(1);
      expect(json.ok).toBe(false);
      expect(json.errors[0]).toContain('request timed out after 30000ms');
    } finally {
      vi.useRealTimers();
    }
  });
});
