import 'fake-indexeddb/auto';

import { describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import {
  decideUpskillLickCard,
  shaEqual,
  shouldSkipNavigateUpskill,
} from '../../src/scoops/upskill-lick-skip.js';
import type { UpskillProvenance } from '../../src/shell/supplemental-commands/upskill/provenance.js';
import { writeProvenance } from '../../src/shell/supplemental-commands/upskill/provenance.js';

const github = vi.hoisted(() => ({ sha: '' }));

vi.mock('../../src/shell/supplemental-commands/upskill/github/github-auth.js', () => ({
  createGitHubRequestContext: async () => ({
    hasToken: true,
    request: async () => ({
      status: 200,
      body: new TextEncoder().encode(JSON.stringify([{ sha: github.sha }])),
    }),
  }),
}));

vi.mock('../../src/shell/proxied-fetch.js', () => ({
  createProxiedFetch: () => async () => {
    throw new Error('proxied fetch unused in skip tests');
  },
}));

const SAME = '3f23c29aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'abebd04bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function githubProvenance(overrides: Partial<UpskillProvenance> = {}): UpskillProvenance {
  return {
    version: 1,
    kind: 'github',
    source: 'ai-ecoverse/skills',
    skill: 'firefly',
    ref: 'main',
    path: 'skills/firefly',
    sha: SAME,
    installed: '2026-07-27T00:00:00.000Z',
    files: ['SKILL.md'],
    ...overrides,
  };
}

describe('shaEqual', () => {
  it('matches full shas case-insensitively and short prefixes', () => {
    expect(shaEqual(SAME, SAME.toUpperCase())).toBe(true);
    expect(shaEqual(SAME, '3f23c29')).toBe(true);
    expect(shaEqual('3f23c29', SAME)).toBe(true);
    expect(shaEqual(SAME, OTHER)).toBe(false);
  });
});

describe('decideUpskillLickCard', () => {
  const lick = {
    target: 'https://github.com/ai-ecoverse/skills',
    branch: 'main',
    path: 'skills/firefly',
  };

  it('skips when the installed skill is already at the advertised path sha', async () => {
    const resolveSha = vi.fn(async () => SAME);
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [{ name: 'firefly', provenance: githubProvenance() }],
      unattributed: [],
      resolveSha,
    });
    expect(decision).toBe('skip-same-sha');
    expect(resolveSha).toHaveBeenCalledWith({
      owner: 'ai-ecoverse',
      repo: 'skills',
      ref: 'main',
      path: 'skills/firefly',
    });
  });

  it('raises when the advertised path sha differs from the recorded install', async () => {
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [{ name: 'firefly', provenance: githubProvenance() }],
      unattributed: [],
      resolveSha: async () => OTHER,
    });
    expect(decision).toBe('raise');
  });

  it('raises when the skill is not installed at all', async () => {
    const resolveSha = vi.fn(async () => SAME);
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [],
      unattributed: [],
      resolveSha,
    });
    expect(decision).toBe('raise');
    expect(resolveSha).not.toHaveBeenCalled();
  });

  it('skips a matching install with no recorded sha (do not spam)', async () => {
    const resolveSha = vi.fn(async () => SAME);
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [{ name: 'firefly', provenance: githubProvenance({ sha: undefined }) }],
      unattributed: [],
      resolveSha,
    });
    expect(decision).toBe('skip-no-provenance');
    expect(resolveSha).not.toHaveBeenCalled();
  });

  it('skips a hand-installed skill with no .upskill record (do not spam)', async () => {
    const resolveSha = vi.fn(async () => SAME);
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [],
      unattributed: ['firefly'],
      resolveSha,
    });
    expect(decision).toBe('skip-no-provenance');
    expect(resolveSha).not.toHaveBeenCalled();
  });

  it('skips when the upstream sha cannot be resolved (do not spam)', async () => {
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [{ name: 'firefly', provenance: githubProvenance() }],
      unattributed: [],
      resolveSha: async () => undefined,
    });
    expect(decision).toBe('skip-no-provenance');
  });

  it('raises a first-time install even when other unattributed skills exist', async () => {
    const decision = await decideUpskillLickCard({
      ...lick,
      provenanced: [],
      unattributed: ['aem', 'github'],
      resolveSha: async () => SAME,
    });
    expect(decision).toBe('raise');
  });

  it('does not match a sibling path from the same repo', async () => {
    const decision = await decideUpskillLickCard({
      ...lick,
      path: 'skills/aem',
      provenanced: [{ name: 'firefly', provenance: githubProvenance() }],
      unattributed: [],
      resolveSha: async () => OTHER,
    });
    expect(decision).toBe('raise');
  });

  it('raises when the target is not a GitHub repo we can compare', async () => {
    const decision = await decideUpskillLickCard({
      target: 'browse:weather.gov/forecast',
      provenanced: [{ name: 'firefly', provenance: githubProvenance() }],
      unattributed: [],
      resolveSha: async () => SAME,
    });
    expect(decision).toBe('raise');
  });
});

describe('shouldSkipNavigateUpskill', () => {
  let dbCounter = 0;

  async function fsWithFirefly(sha?: string): Promise<VirtualFS> {
    const fs = await VirtualFS.create({
      dbName: `upskill-lick-skip-${dbCounter++}`,
      wipe: true,
    });
    await fs.mkdir('/workspace/skills/firefly', { recursive: true });
    await fs.writeFile('/workspace/skills/firefly/SKILL.md', '# firefly\n');
    await writeProvenance(fs, 'firefly', {
      kind: 'github',
      source: 'ai-ecoverse/skills',
      skill: 'firefly',
      ref: 'main',
      path: 'skills/firefly',
      sha,
      files: ['SKILL.md'],
    });
    return fs;
  }

  const event = {
    body: {
      verb: 'upskill',
      target: 'https://github.com/ai-ecoverse/skills',
      path: 'skills/firefly',
    },
  };

  it('skips when installed at the same sha', async () => {
    github.sha = SAME;
    const fs = await fsWithFirefly(SAME);
    await expect(shouldSkipNavigateUpskill(event, () => fs)).resolves.toBe(true);
  });

  it('does not skip when the advertised sha differs', async () => {
    github.sha = OTHER;
    const fs = await fsWithFirefly(SAME);
    await expect(shouldSkipNavigateUpskill(event, () => fs)).resolves.toBe(false);
  });

  it('skips when the matching install has no recorded sha', async () => {
    github.sha = SAME;
    const fs = await fsWithFirefly(undefined);
    await expect(shouldSkipNavigateUpskill(event, () => fs)).resolves.toBe(true);
  });

  it('does not skip a first-time install', async () => {
    github.sha = SAME;
    const fs = await VirtualFS.create({
      dbName: `upskill-lick-skip-${dbCounter++}`,
      wipe: true,
    });
    await expect(shouldSkipNavigateUpskill(event, () => fs)).resolves.toBe(false);
  });
});
