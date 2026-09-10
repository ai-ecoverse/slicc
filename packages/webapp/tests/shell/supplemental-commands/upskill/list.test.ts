import 'fake-indexeddb/auto';

import { zipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetGlobalFsCache,
  createUpskillCommand,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

let dbCounter = 0;

function repoZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    entries[`skills-main/${path}`] = new TextEncoder().encode(content);
  }
  return zipSync(entries);
}

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

const MOVED_SHA = 'b'.repeat(40);

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

async function configureToken(): Promise<void> {
  const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
  await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');
}

async function installAlpha(fs: VirtualFS, files: Record<string, string>): Promise<void> {
  const cmd = createUpskillCommand(fs, repoFetch(files) as unknown as SecureFetch);
  const result = await cmd.execute(['octo/skills', '--skill', 'alpha'], createMockCtx() as never);
  expect(result.exitCode).toBe(0);
}

async function writeUnattributedSkill(fs: VirtualFS, name: string): Promise<void> {
  await fs.mkdir(`/workspace/skills/${name}`, { recursive: true });
  await fs.writeFile(
    `/workspace/skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Bundled ${name}\n---\n# ${name}\n`
  );
}

describe('upskill list', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `upskill-list-${dbCounter++}`, wipe: true });
    await configureToken();
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await fs.dispose();
    vi.restoreAllMocks();
  });

  /**
   * Pins the default listing so `--outdated` / `--json` cannot regress the
   * "what can I use right now" answer. The exact bytes here are the unfixed
   * `upskill list` output for this fixture.
   */
  it('keeps default list output byte-identical for a mixed fixture', async () => {
    await writeUnattributedSkill(fs, 'legacy');
    await fs.mkdir('/workspace/skills/alpha', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/alpha/SKILL.md',
      '---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n'
    );

    const cmd = createUpskillCommand(fs, vi.fn() as never);
    const result = await cmd.execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatchInlineSnapshot(`
      "Discoverable local skills:

        NAME    SOURCE      DESCRIPTION
      ───────────────────────────────────────────────────────────────────────────────────────────────────
        alpha   native      Alpha skill
        legacy  native      Bundled legacy

      Discovery roots: /workspace/skills plus accessible **/.agents/skills/*, **/.claude/skills/*, **/.claude-plugin/marketplace.json skill collections anywhere in the VFS, and installed agent plugins (\`plugin list\`).
      "
    `);
  });

  it('rejects an unknown flag with a non-zero exit that names the flag', async () => {
    await writeUnattributedSkill(fs, 'legacy');
    const cmd = createUpskillCommand(fs, vi.fn() as never);
    const result = await cmd.execute(['list', '--this-flag-is-nonsense'], createMockCtx() as never);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--this-flag-is-nonsense');
    expect(result.stdout).not.toContain('Discoverable local skills');
  });

  it('lists only genuinely stale skills under --outdated, and does not report a provenance-less skill as current', async () => {
    await installAlpha(fs, V1);
    await writeUnattributedSkill(fs, 'legacy');

    const fetchMock = repoFetch(V2, MOVED_SHA);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['list', '--outdated'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha');
    expect(result.stdout).not.toContain('Discoverable local skills');
    // The provenance-less skill must not render as up to date — that is the
    // false negative this flag used to produce by listing everything.
    expect(result.stdout).not.toMatch(/legacy: already current/);
    expect(result.stdout).toMatch(/no install provenance|not checked|unknown/i);
    // It may be named in the skipped/unknown footer, but it is not a listed
    // current skill: the only skill row is the genuinely stale one.
    expect(result.stdout).toContain('alpha');
    const listedAsSkillRow = [...result.stdout.matchAll(/^\s+legacy\b/gm)];
    expect(listedAsSkillRow).toHaveLength(0);
  });

  it('omits a current provenanced skill from --outdated', async () => {
    await installAlpha(fs, V1);

    const fetchMock = repoFetch(V1);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['list', '--outdated'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Discoverable local skills');
    expect(result.stdout).not.toMatch(/^\s+alpha\b/m);
    expect(result.stdout).not.toMatch(/alpha: already current/);
  });

  it('exits 0 from --outdated whether or not anything is stale', async () => {
    await installAlpha(fs, V1);
    await writeUnattributedSkill(fs, 'legacy');

    const stale = await createUpskillCommand(
      fs,
      repoFetch(V2, MOVED_SHA) as unknown as SecureFetch
    ).execute(['list', '--outdated'], createMockCtx() as never);
    expect(stale.exitCode).toBe(0);

    const current = await createUpskillCommand(fs, repoFetch(V1) as unknown as SecureFetch).execute(
      ['list', '--outdated'],
      createMockCtx() as never
    );
    expect(current.exitCode).toBe(0);
  });

  it('emits structured JSON for --json, matching sibling subcommands', async () => {
    await writeUnattributedSkill(fs, 'legacy');
    const cmd = createUpskillCommand(fs, vi.fn() as never);
    const result = await cmd.execute(['list', '--json'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      skills: Array<{ name: string; source: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'legacy', source: 'native' })])
    );
  });

  it('help documents list --outdated and list --json', async () => {
    const cmd = createUpskillCommand(fs, vi.fn() as never);
    const result = await cmd.execute(['--help'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('list [--outdated] [--json]');
    expect(result.stdout).toContain('--outdated');
    expect(result.stdout).toContain('upskill list --outdated');
    expect(result.stdout).toContain('upskill list --json');
  });

  it('emits only stale skills plus skipped names under --outdated --json', async () => {
    await installAlpha(fs, V1);
    await writeUnattributedSkill(fs, 'legacy');

    const cmd = createUpskillCommand(fs, repoFetch(V2, MOVED_SHA) as unknown as SecureFetch);
    const result = await cmd.execute(['list', '--outdated', '--json'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      results: Array<{ skill: string; outcome: string }>;
      skipped: string[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toEqual([
      expect.objectContaining({ skill: 'alpha', outcome: 'updated' }),
    ]);
    expect(parsed.skipped).toEqual(['legacy']);
    expect(parsed.results.every((r) => r.outcome === 'updated')).toBe(true);
  });
});
