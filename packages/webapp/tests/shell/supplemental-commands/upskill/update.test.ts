import 'fake-indexeddb/auto';

import { zipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetGlobalFsCache,
  createUpskillCommand,
  readProvenance,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

let dbCounter = 0;

/** Build a codeload-shaped ZIP (entries nested under a top-level repo dir). */
function repoZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`skills-main/${path}`] = new TextEncoder().encode(content);
  }
  return zipSync(entries);
}

/**
 * Fetch mock serving one repo tree over codeload plus the commit endpoint the
 * provenance sha lookup uses. Anything else throws, so an unexpected network
 * call fails the test loudly.
 */
function repoFetch(files: Record<string, string>, sha = 'a'.repeat(40)) {
  return vi.fn(async (url: string) => {
    if (url.includes('raw.githubusercontent.com')) throw new Error(`unexpected url: ${url}`);
    if (url.includes('codeload.github.com')) return response(200, repoZip(files));
    if (url.includes('api.github.com') && url.includes('/commits/')) {
      return response(200, JSON.stringify({ sha }));
    }
    throw new Error(`unexpected url: ${url}`);
  });
}

const V1 = {
  'alpha/SKILL.md': '# Alpha v1\n',
  'alpha/scripts/run.sh': 'echo v1\n',
  'alpha/scripts/gone.sh': 'echo doomed\n',
  'alpha/.gitignore': 'node_modules\n',
};

const V2 = {
  'alpha/SKILL.md': '# Alpha v2\n',
  'alpha/scripts/run.sh': 'echo v2\n',
  'alpha/scripts/new.sh': 'echo new\n',
  'alpha/.gitignore': 'dist\n',
};

/**
 * Configure a GitHub token. The sha lookup is token-gated so anonymous
 * installs keep spending zero rate-limited requests (see `provenance.ts`).
 */
async function configureToken(): Promise<void> {
  const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
  await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');
}

async function installAlpha(fs: VirtualFS, files: Record<string, string>): Promise<void> {
  const cmd = createUpskillCommand(fs, repoFetch(files) as unknown as SecureFetch);
  const result = await cmd.execute(['octo/skills', '--skill', 'alpha'], createMockCtx() as never);
  expect(result.exitCode).toBe(0);
}

describe('upskill install — dotfile protection and provenance', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `upskill-update-${dbCounter++}`, wipe: true });
    await configureToken();
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await fs.dispose();
    vi.restoreAllMocks();
  });

  it('records install provenance in .upskill', async () => {
    await installAlpha(fs, V1);

    const provenance = await readProvenance(fs, 'alpha');
    expect(provenance).toMatchObject({
      kind: 'github',
      source: 'octo/skills',
      skill: 'alpha',
      path: 'alpha',
      sha: 'a'.repeat(40),
    });
    expect(provenance?.files).toContain('SKILL.md');
    expect(provenance?.files).toContain('scripts/run.sh');
    expect(typeof provenance?.installed).toBe('string');
  });

  it('--force keeps credential dotfiles at any depth instead of wiping the directory', async () => {
    await installAlpha(fs, V1);
    await fs.writeFile('/workspace/skills/alpha/.config', 'PROBE_SECRET=keep-me\n');
    await fs.writeFile('/workspace/skills/alpha/scripts/.config', 'TOKEN=nested\n');

    const cmd = createUpskillCommand(fs, repoFetch(V2) as unknown as SecureFetch);
    const result = await cmd.execute(
      ['octo/skills', '--skill', 'alpha', '--force'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    await expect(fs.readTextFile('/workspace/skills/alpha/.config')).resolves.toBe(
      'PROBE_SECRET=keep-me\n'
    );
    await expect(fs.readTextFile('/workspace/skills/alpha/scripts/.config')).resolves.toBe(
      'TOKEN=nested\n'
    );
    // Provenance survives the reinstall that consumes it, and content updated.
    expect(await readProvenance(fs, 'alpha')).not.toBeNull();
    await expect(fs.readTextFile('/workspace/skills/alpha/SKILL.md')).resolves.toBe('# Alpha v2\n');
  });

  it('never overwrites an existing upstream dotfile on reinstall', async () => {
    await installAlpha(fs, V1);
    // First install seeds the upstream dotfile…
    await expect(fs.readTextFile('/workspace/skills/alpha/.gitignore')).resolves.toBe(
      'node_modules\n'
    );
    await fs.writeFile('/workspace/skills/alpha/.gitignore', 'my-own-ignore\n');

    const cmd = createUpskillCommand(fs, repoFetch(V2) as unknown as SecureFetch);
    await cmd.execute(['octo/skills', '--skill', 'alpha', '--force'], createMockCtx() as never);

    // …and a later install leaves the user's edit alone.
    await expect(fs.readTextFile('/workspace/skills/alpha/.gitignore')).resolves.toBe(
      'my-own-ignore\n'
    );
  });

  it('an anonymous install still spends no rate-limited API request', async () => {
    _resetGlobalFsCache();
    const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
    await globalFs.rm('/workspace/.git/github-token').catch(() => {});
    _resetGlobalFsCache();

    const fetchMock = repoFetch(V1);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['octo/skills', '--skill', 'alpha'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('api.github.com');
    }
    // Provenance is still recorded — just without a sha.
    const provenance = await readProvenance(fs, 'alpha');
    expect(provenance?.source).toBe('octo/skills');
    expect(provenance?.sha).toBeUndefined();
  });

  it('info reports the recorded source, not just the root kind', async () => {
    await installAlpha(fs, V1);

    const cmd = createUpskillCommand(fs, repoFetch(V1) as unknown as SecureFetch);
    const result = await cmd.execute(['info', 'alpha'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Source: native');
    expect(result.stdout).toContain('Installed from: github:octo/skills');
    expect(result.stdout).toContain(`Commit: ${'a'.repeat(40)}`);
  });
});

describe('upskill update', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `upskill-update-${dbCounter++}`, wipe: true });
    await configureToken();
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await fs.dispose();
    vi.restoreAllMocks();
  });

  it('reports "already current" when nothing changed upstream', async () => {
    await installAlpha(fs, V1);

    const cmd = createUpskillCommand(fs, repoFetch(V1) as unknown as SecureFetch);
    const result = await cmd.execute(['update'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha: already current');
    expect(result.stdout).toContain('all skills are current');
  });

  it('--dry-run classifies every path and writes nothing', async () => {
    await installAlpha(fs, V1);

    const cmd = createUpskillCommand(fs, repoFetch(V2) as unknown as SecureFetch);
    const result = await cmd.execute(['update', 'alpha', '--dry-run'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dry run — nothing written');
    expect(result.stdout).toContain('would update');
    expect(result.stdout).toMatch(/updated\s+SKILL\.md/);
    expect(result.stdout).toMatch(/added\s+scripts\/new\.sh/);
    expect(result.stdout).toMatch(/removed\s+scripts\/gone\.sh/);
    // Nothing on disk moved.
    await expect(fs.readTextFile('/workspace/skills/alpha/SKILL.md')).resolves.toBe('# Alpha v1\n');
    await expect(fs.exists('/workspace/skills/alpha/scripts/new.sh')).resolves.toBe(false);
    await expect(fs.exists('/workspace/skills/alpha/scripts/gone.sh')).resolves.toBe(true);
  });

  it('applies upstream changes, drops files upstream removed, keeps local additions', async () => {
    await installAlpha(fs, V1);
    await fs.writeFile('/workspace/skills/alpha/.config', 'PROBE_SECRET=keep-me\n');
    await fs.writeFile('/workspace/skills/alpha/NOTES-local.md', 'user notes\n');

    const cmd = createUpskillCommand(fs, repoFetch(V2, 'b'.repeat(40)) as unknown as SecureFetch);
    const result = await cmd.execute(['update', 'alpha'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha: updated from github:octo/skills');
    await expect(fs.readTextFile('/workspace/skills/alpha/SKILL.md')).resolves.toBe('# Alpha v2\n');
    await expect(fs.readTextFile('/workspace/skills/alpha/scripts/new.sh')).resolves.toBe(
      'echo new\n'
    );
    // Upstream dropped this one and provenance says we installed it.
    await expect(fs.exists('/workspace/skills/alpha/scripts/gone.sh')).resolves.toBe(false);
    // The user's own files — dotfile or not — stay.
    await expect(fs.readTextFile('/workspace/skills/alpha/.config')).resolves.toBe(
      'PROBE_SECRET=keep-me\n'
    );
    await expect(fs.readTextFile('/workspace/skills/alpha/NOTES-local.md')).resolves.toBe(
      'user notes\n'
    );
    // Provenance advanced to the new sha and file list.
    const provenance = await readProvenance(fs, 'alpha');
    expect(provenance?.sha).toBe('b'.repeat(40));
    expect(provenance?.files).toContain('scripts/new.sh');
    expect(provenance?.files).not.toContain('scripts/gone.sh');
  });

  it('--json emits the classification for scripted callers', async () => {
    await installAlpha(fs, V1);

    const cmd = createUpskillCommand(fs, repoFetch(V2) as unknown as SecureFetch);
    const result = await cmd.execute(
      ['update', 'alpha', '--dry-run', '--json'],
      createMockCtx() as never
    );

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      results: Array<{
        skill: string;
        outcome: string;
        changes: Array<{ path: string; status: string }>;
      }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.results[0].skill).toBe('alpha');
    expect(parsed.results[0].outcome).toBe('updated');
    expect(parsed.results[0].changes).toContainEqual({ path: 'SKILL.md', status: 'updated' });
    // An existing dotfile is reported, never rewritten.
    expect(parsed.results[0].changes).toContainEqual({ path: '.gitignore', status: 'kept-local' });
  });

  it('honors --branch as a one-off override of the recorded ref', async () => {
    await installAlpha(fs, V1);

    const fetchMock = repoFetch(V2);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    await cmd.execute(['update', 'alpha', '--branch', 'dev'], createMockCtx() as never);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/zip/refs/heads/dev'))).toBe(
      true
    );
  });

  it('rejects an unsafe --branch before any network call', async () => {
    await installAlpha(fs, V1);

    const fetchMock = repoFetch(V2);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['update', 'alpha', '--branch', 'main;rm -rf /'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--branch must be a git ref');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains how to recover when a skill has no provenance', async () => {
    await fs.mkdir('/workspace/skills/legacy', { recursive: true });
    await fs.writeFile('/workspace/skills/legacy/SKILL.md', '# Legacy\n');

    const fetchMock = repoFetch(V1);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['update', 'legacy'], createMockCtx() as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no install provenance for "legacy"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a failure when the skill path is gone upstream', async () => {
    await installAlpha(fs, V1);

    const cmd = createUpskillCommand(
      fs,
      repoFetch({ 'beta/SKILL.md': '# Beta\n' }) as unknown as SecureFetch
    );
    const result = await cmd.execute(['update', 'alpha'], createMockCtx() as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('may have moved or been removed upstream');
    await expect(fs.readTextFile('/workspace/skills/alpha/SKILL.md')).resolves.toBe('# Alpha v1\n');
  });

  it('upgrade is an alias for update', async () => {
    await installAlpha(fs, V1);

    const cmd = createUpskillCommand(fs, repoFetch(V1) as unknown as SecureFetch);
    const result = await cmd.execute(['upgrade', '--dry-run'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha: already current');
  });

  it('help documents update, --dry-run, and the dotfile rule', async () => {
    const cmd = createUpskillCommand(fs, repoFetch(V1) as unknown as SecureFetch);
    const result = await cmd.execute(['--help'], createMockCtx() as never);

    expect(result.stdout).toContain('upskill update');
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('never modifies or deletes a dotfile');
  });
});
