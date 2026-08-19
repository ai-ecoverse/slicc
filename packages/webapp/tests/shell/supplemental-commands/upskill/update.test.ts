import 'fake-indexeddb/auto';

import { zipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetGlobalFsCache,
  createUpskillCommand,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import type { UpskillProvenance } from '../../../../src/shell/supplemental-commands/upskill/provenance.js';
import { createMockCtx, response } from './test-helpers.js';

let dbCounter = 0;

const OWNER = 'ai-ecoverse';
const REPO = 'skills';
const SKILL = 'mixtape';
const SKILL_DIR = `/workspace/skills/${SKILL}`;
const OLD_SHA = 'a'.repeat(40);
const NEW_SHA = 'b'.repeat(40);

/** Build a codeload-shaped ZIP: entries are prefixed with `<repo>-<ref>/`. */
function repoZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  for (const [path, content] of Object.entries(files)) {
    entries[`${REPO}-main/${path}`] = encoder.encode(content);
  }
  return zipSync(entries);
}

/**
 * A fetch double that answers the two endpoints `update` uses: the commits API
 * (ref → sha) and the codeload ZIP. Everything else 404s so an unexpected call
 * shows up as a test failure rather than a silent fallback.
 */
function mockFetch(options: {
  headSha?: string;
  upstream?: Record<string, string>;
}): SecureFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.includes('api.github.com') && url.includes('/commits/')) {
      if (!options.headSha) return response(404, '{}');
      return response(200, JSON.stringify({ sha: options.headSha }));
    }
    if (url.startsWith('https://codeload.github.com/')) {
      if (!options.upstream) return response(404, '');
      return response(200, repoZip(options.upstream));
    }
    return response(404, '');
  }) as unknown as SecureFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function seedSkill(
  fs: VirtualFS,
  files: Record<string, string>,
  provenance?: Partial<UpskillProvenance> | null
): Promise<void> {
  await fs.mkdir(SKILL_DIR, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = `${SKILL_DIR}/${relative}`;
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (parent !== SKILL_DIR) await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(target, content);
  }
  if (provenance === null) return;
  const record: UpskillProvenance = {
    version: 1,
    kind: 'github',
    owner: OWNER,
    repo: REPO,
    path: `skills/${SKILL}`,
    ref: 'main',
    sha: OLD_SHA,
    installedAt: '2026-01-01T00:00:00.000Z',
    ...provenance,
  };
  await fs.writeFile(`${SKILL_DIR}/.upskill`, `${JSON.stringify(record, null, 2)}\n`);
}

/** Snapshot every file in a skill dir as `path -> bytes` for exact comparison. */
async function snapshot(fs: VirtualFS, dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await fs.readDir(current)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'directory') {
        await walk(`${current}/${entry.name}`, relative);
      } else {
        out.set(relative, await fs.readTextFile(`${current}/${entry.name}`));
      }
    }
  }
  await walk(dir, '');
  return out;
}

describe('upskill update', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-upskill-update-${dbCounter++}`, wipe: true });
  });

  afterEach(() => {
    _resetGlobalFsCache();
  });

  it('reports "already current" and rewrites nothing when the recorded sha matches HEAD', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Mixtape\n' }, { sha: OLD_SHA });
    const before = await snapshot(fs, SKILL_DIR);
    const fetchFn = mockFetch({ headSha: OLD_SHA });

    const result = await createUpskillCommand(fs, fetchFn).execute(
      ['update', SKILL],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${SKILL}: already current`);
    expect(result.stdout).not.toContain('updated to');
    // The sha short-circuit must not even reach for the tree.
    expect(fetchFn.calls.some((url) => url.startsWith('https://codeload.'))).toBe(false);
    expect(await snapshot(fs, SKILL_DIR)).toEqual(before);
  });

  it('reports "already current" distinctly from "updated to <sha>"', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' });
    const result = await createUpskillCommand(
      fs,
      mockFetch({ headSha: NEW_SHA, upstream: { [`skills/${SKILL}/SKILL.md`]: '# New\n' } })
    ).execute(['update', SKILL], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${SKILL}: updated to ${NEW_SHA.slice(0, 7)}`);
    expect(result.stdout).not.toContain('already current');
  });

  it('classifies changed, added and removed paths and records the new sha', async () => {
    await seedSkill(fs, {
      'SKILL.md': '# Old\n',
      'scripts/run.sh': 'old\n',
      'stale.md': 'gone upstream\n',
    });

    const result = await createUpskillCommand(
      fs,
      mockFetch({
        headSha: NEW_SHA,
        upstream: {
          [`skills/${SKILL}/SKILL.md`]: '# New\n',
          [`skills/${SKILL}/scripts/run.sh`]: 'old\n',
          [`skills/${SKILL}/scripts/extra.sh`]: 'brand new\n',
        },
      })
    ).execute(['update', SKILL], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('updated     SKILL.md');
    expect(result.stdout).toContain('added       scripts/extra.sh');
    expect(result.stdout).toContain('removed     stale.md');
    expect(result.stdout).toContain('unchanged   (1 file(s))');

    expect(await fs.readTextFile(`${SKILL_DIR}/SKILL.md`)).toBe('# New\n');
    expect(await fs.readTextFile(`${SKILL_DIR}/scripts/extra.sh`)).toBe('brand new\n');
    expect(await fs.exists(`${SKILL_DIR}/stale.md`)).toBe(false);

    const provenance = JSON.parse(await fs.readTextFile(`${SKILL_DIR}/.upskill`));
    expect(provenance.sha).toBe(NEW_SHA);
    expect(provenance.owner).toBe(OWNER);
  });

  it('leaves a pre-existing dotfile byte-identical across an update', async () => {
    // The scenario from issue #2186: `.config` holds live credentials, and
    // upstream ships its own copy of the same path.
    await seedSkill(fs, {
      'SKILL.md': '# Old\n',
      'scripts/.config': 'PROBE_SECRET=keep-me\n',
    });

    const result = await createUpskillCommand(
      fs,
      mockFetch({
        headSha: NEW_SHA,
        upstream: {
          [`skills/${SKILL}/SKILL.md`]: '# New\n',
          [`skills/${SKILL}/scripts/.config`]: 'PROBE_SECRET=clobbered\n',
        },
      })
    ).execute(['update', SKILL], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('kept-local  scripts/.config');
    expect(await fs.readTextFile(`${SKILL_DIR}/scripts/.config`)).toBe('PROBE_SECRET=keep-me\n');
  });

  it('never deletes a dotfile upstream no longer ships', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n', '.config': 'PROBE_SECRET=keep-me\n' });

    const result = await createUpskillCommand(
      fs,
      mockFetch({ headSha: NEW_SHA, upstream: { [`skills/${SKILL}/SKILL.md`]: '# New\n' } })
    ).execute(['update', SKILL], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('kept-local  .config');
    expect(await fs.readTextFile(`${SKILL_DIR}/.config`)).toBe('PROBE_SECRET=keep-me\n');
  });

  it('--dry-run leaves the filesystem byte-identical', async () => {
    await seedSkill(fs, {
      'SKILL.md': '# Old\n',
      '.config': 'PROBE_SECRET=keep-me\n',
      'stale.md': 'gone upstream\n',
    });
    const before = await snapshot(fs, SKILL_DIR);

    const result = await createUpskillCommand(
      fs,
      mockFetch({
        headSha: NEW_SHA,
        upstream: {
          [`skills/${SKILL}/SKILL.md`]: '# New\n',
          [`skills/${SKILL}/added.md`]: 'new file\n',
        },
      })
    ).execute(['update', SKILL, '--dry-run'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no files written');
    expect(result.stdout).toContain(`${SKILL}: would update to ${NEW_SHA.slice(0, 7)}`);
    expect(result.stdout).toContain('updated     SKILL.md');
    expect(result.stdout).toContain('added       added.md');
    expect(result.stdout).toContain('removed     stale.md');
    // Side-effect freedom is the contract, so assert the tree, not the wording.
    expect(await snapshot(fs, SKILL_DIR)).toEqual(before);
  });

  it('--dry-run does not rewrite provenance even when content already matches', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Same\n' }, { sha: undefined });
    const before = await snapshot(fs, SKILL_DIR);

    const result = await createUpskillCommand(
      fs,
      mockFetch({ headSha: NEW_SHA, upstream: { [`skills/${SKILL}/SKILL.md`]: '# Same\n' } })
    ).execute(['update', SKILL, '--dry-run'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already current');
    expect(await snapshot(fs, SKILL_DIR)).toEqual(before);
  });

  it('gives a graceful message for a skill with no .upskill record', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Legacy\n' }, null);

    const result = await createUpskillCommand(fs, mockFetch({})).execute(
      ['update', SKILL],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('no recorded source');
    expect(result.stdout).toContain('--from <owner>/<repo>');
    expect(result.stderr).toBe('');
  });

  it('records provenance when --from supplies the source once', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Legacy\n' }, null);

    const result = await createUpskillCommand(
      fs,
      mockFetch({ headSha: NEW_SHA, upstream: { [`skills/${SKILL}/SKILL.md`]: '# Fresh\n' } })
    ).execute(['update', SKILL, '--from', `${OWNER}/${REPO}`], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('updated to');
    const provenance = JSON.parse(await fs.readTextFile(`${SKILL_DIR}/.upskill`));
    expect(provenance).toMatchObject({
      kind: 'github',
      owner: OWNER,
      repo: REPO,
      path: `skills/${SKILL}`,
      sha: NEW_SHA,
    });
  });

  it('honours --branch over the recorded ref', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' }, { sha: OLD_SHA });
    const fetchFn = mockFetch({
      headSha: OLD_SHA,
      upstream: { [`skills/${SKILL}/SKILL.md`]: '# From other ref\n' },
    });

    const result = await createUpskillCommand(fs, fetchFn).execute(
      ['update', SKILL, '--branch', 'next'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    // Same sha as recorded, but an explicit ref must still compare the tree.
    expect(result.stdout).toContain('updated to');
    expect(fetchFn.calls.some((url) => url.includes('/commits/next'))).toBe(true);
    expect(fetchFn.calls.some((url) => url.includes('/zip/refs/heads/next'))).toBe(true);
    expect(await fs.readTextFile(`${SKILL_DIR}/SKILL.md`)).toBe('# From other ref\n');
  });

  it('rejects an unsafe --branch value', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' });

    const result = await createUpskillCommand(fs, mockFetch({})).execute(
      ['update', SKILL, '--branch', 'a;rm -rf /'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--branch requires a safe git ref');
  });

  it('skips browse.sh skills with an actionable message', async () => {
    await seedSkill(
      fs,
      { 'SKILL.md': '# Browse\n' },
      {
        kind: 'browse.sh',
        slug: 'weather.gov/get-forecast-1uezib',
        owner: undefined,
        repo: undefined,
      }
    );

    const result = await createUpskillCommand(fs, mockFetch({})).execute(
      ['update', SKILL],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('upskill browse:weather.gov/get-forecast-1uezib --force');
  });

  it('errors when the named skill is not installed', async () => {
    const result = await createUpskillCommand(fs, mockFetch({})).execute(
      ['update', 'nope'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is not installed');
  });

  it('with no skill name updates every skill that has provenance', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' }, { sha: OLD_SHA });
    await fs.mkdir('/workspace/skills/untracked', { recursive: true });
    await fs.writeFile('/workspace/skills/untracked/SKILL.md', '# Untracked\n');

    const result = await createUpskillCommand(fs, mockFetch({ headSha: OLD_SHA })).execute(
      ['update'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${SKILL}: already current`);
    expect(result.stdout).not.toContain('untracked');
  });

  it('with no provenance anywhere explains how to record it', async () => {
    await fs.mkdir('/workspace/skills/legacy', { recursive: true });
    await fs.writeFile('/workspace/skills/legacy/SKILL.md', '# Legacy\n');

    const result = await createUpskillCommand(fs, mockFetch({})).execute(
      ['update'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No skills with a recorded install source');
    expect(result.stdout).toContain('--from <owner>/<repo>');
  });

  it('accepts `upgrade` as an alias of `update`', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' }, { sha: OLD_SHA });

    const result = await createUpskillCommand(fs, mockFetch({ headSha: OLD_SHA })).execute(
      ['upgrade', SKILL],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${SKILL}: already current`);
  });

  it('documents update, dry-run and the dotfile rule in --help', async () => {
    const result = await createUpskillCommand(fs, mockFetch({})).execute(
      ['--help'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('upskill update');
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).toContain('upskill outdated');
    expect(result.stdout).toContain('never overwrites and never deletes a dotfile');
  });
});

describe('upskill outdated', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-upskill-outdated-${dbCounter++}`, wipe: true });
  });

  afterEach(() => {
    _resetGlobalFsCache();
  });

  it('lists a skill whose recorded sha is behind its source', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' }, { sha: OLD_SHA });

    const result = await createUpskillCommand(fs, mockFetch({ headSha: NEW_SHA })).execute(
      ['outdated'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Outdated skills:');
    expect(result.stdout).toContain(`${OLD_SHA.slice(0, 7)} → ${NEW_SHA.slice(0, 7)}`);
  });

  it('reports all current when every recorded sha matches', async () => {
    await seedSkill(fs, { 'SKILL.md': '# Old\n' }, { sha: OLD_SHA });

    const result = await createUpskillCommand(fs, mockFetch({ headSha: OLD_SHA })).execute(
      ['outdated'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('All 1 tracked skill(s) are current.');
  });
});

describe('upskill install dotfile protection', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-upskill-force-${dbCounter++}`, wipe: true });
  });

  afterEach(() => {
    _resetGlobalFsCache();
  });

  it('--force keeps existing dotfiles while replacing non-dot content', async () => {
    // Exactly the reproduction from issue #2186 — `.config` and `.upskill`
    // survive; a non-dot local file upstream does not ship does not.
    await seedSkill(fs, {
      'SKILL.md': '# Old\n',
      '.config': 'PROBE_SECRET=keep-me\n',
      'NOTES-local.md': 'user notes\n',
    });

    const result = await createUpskillCommand(
      fs,
      mockFetch({
        headSha: NEW_SHA,
        upstream: {
          [`skills/${SKILL}/SKILL.md`]: '# New\n',
          [`skills/${SKILL}/helper.sh`]: 'echo hi\n',
        },
      })
    ).execute([`${OWNER}/${REPO}`, '--skill', SKILL, '--force'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(await fs.readTextFile(`${SKILL_DIR}/.config`)).toBe('PROBE_SECRET=keep-me\n');
    expect(await fs.readTextFile(`${SKILL_DIR}/SKILL.md`)).toBe('# New\n');
    expect(await fs.readTextFile(`${SKILL_DIR}/helper.sh`)).toBe('echo hi\n');
    expect(await fs.exists(`${SKILL_DIR}/NOTES-local.md`)).toBe(false);
    // Provenance is rewritten by the install, so the next `update` needs no args.
    const provenance = JSON.parse(await fs.readTextFile(`${SKILL_DIR}/.upskill`));
    expect(provenance).toMatchObject({ kind: 'github', owner: OWNER, repo: REPO });
  });

  it('installs a dotfile upstream ships when the skill directory does not have it', async () => {
    const result = await createUpskillCommand(
      fs,
      mockFetch({
        headSha: NEW_SHA,
        upstream: {
          [`skills/${SKILL}/SKILL.md`]: '# Fresh\n',
          [`skills/${SKILL}/scripts/.gitignore`]: '.config\n',
        },
      })
    ).execute([`${OWNER}/${REPO}`, '--skill', SKILL], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(await fs.readTextFile(`${SKILL_DIR}/scripts/.gitignore`)).toBe('.config\n');
  });

  it('records provenance without spending a GitHub API call', async () => {
    const fetchFn = mockFetch({
      headSha: NEW_SHA,
      upstream: { [`skills/${SKILL}/SKILL.md`]: '# Fresh\n' },
    });

    const result = await createUpskillCommand(fs, fetchFn).execute(
      [`${OWNER}/${REPO}`, '--skill', SKILL],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    // Installs stay on the un-rate-limited codeload path; the sha is resolved
    // lazily by the first `update`.
    expect(fetchFn.calls.some((url) => url.includes('api.github.com'))).toBe(false);
    const provenance = JSON.parse(await fs.readTextFile(`${SKILL_DIR}/.upskill`));
    expect(provenance.sha).toBeUndefined();
    expect(provenance).toMatchObject({ owner: OWNER, repo: REPO, path: `skills/${SKILL}` });
  });
});
