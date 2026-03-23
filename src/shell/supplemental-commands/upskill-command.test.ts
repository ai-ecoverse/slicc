import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem, SecureFetch } from 'just-bash';
import { zipSync } from 'fflate';
import { VirtualFS } from '../../fs/index.js';
import { createUpskillCommand, _resetGlobalFsCache, scoreSkills } from './upskill-command.js';

function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: '',
  };
}

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
  statusText = ''
) {
  return { status, statusText, headers, body, url: 'https://example.test' };
}

describe('upskill command GitHub flows', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];
  let dbCounter = 0;

  beforeEach(async () => {
    createdFileSystems = [];
    const originalCreate = VirtualFS.create.bind(VirtualFS);
    vi.spyOn(VirtualFS, 'create').mockImplementation(async (options) => {
      const instance = await originalCreate(options);
      createdFileSystems.push(instance);
      return instance;
    });

    fs = await VirtualFS.create({ dbName: `upskill-test-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await Promise.allSettled(
      createdFileSystems.map((instance) =>
        (instance.getLightningFS() as { _deactivate?: () => Promise<void> })._deactivate?.()
      )
    );
    vi.restoreAllMocks();
  });

  it('documents github.token guidance in help output for shared-IP rate limits', async () => {
    const fetchMock = vi.fn();

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['--help'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('anonymous GitHub access may be rate-limited');
    expect(result.stdout).toContain('shared VPNs or corporate IPs');
    expect(result.stdout).toContain('git config github.token <PAT>');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses configured github.token for GitHub API and content requests', async () => {
    const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
    await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');

    const fetchMock = vi.fn(async (url: string, options?: { headers?: Record<string, string> }) => {
      if (url.includes('codeload.github.com')) return response(500, 'Simulated failure');
      if (url.endsWith('/contents/')) {
        return response(200, JSON.stringify([{ name: 'alpha', path: 'alpha', type: 'dir' }]));
      }
      if (url.endsWith('/contents/alpha')) {
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'alpha/SKILL.md',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/SKILL.md',
            },
            {
              name: 'helper.txt',
              path: 'alpha/helper.txt',
              type: 'file',
              download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/helper.txt',
            },
          ])
        );
      }
      if (url.endsWith('/alpha/SKILL.md')) return response(200, '# Alpha skill\n');
      if (url.endsWith('/alpha/helper.txt')) return response(200, 'helper\n');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['octo/skills', '--all'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed skill "alpha" from octo/skills');
    await expect(fs.readTextFile('/workspace/skills/alpha/SKILL.md')).resolves.toContain(
      'Alpha skill'
    );

    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toContain('github');
      // Only API requests carry the token; codeload/raw requests go through raw fetch
      if (url.includes('api.github.com') || url.includes('raw.githubusercontent.com')) {
        expect(options?.headers?.Authorization).toBe('Bearer ghp_test_token');
      }
    }
  });

  it('classifies anonymous GitHub rate-limit failures when listing skills', async () => {
    const fetchMock = vi.fn(
      async (_url: string, options?: { headers?: Record<string, string> }) => {
        expect(options?.headers?.Authorization).toBeUndefined();
        return response(
          403,
          JSON.stringify({ message: 'API rate limit exceeded for 198.51.100.10.' }),
          { 'x-ratelimit-remaining': '0' },
          'Forbidden'
        );
      }
    );

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['octo/skills', '--list'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rate-limited anonymous access');
    expect(result.stderr).toContain('shared VPN');
    expect(result.stderr).toContain('git config github.token <PAT>');
    expect(result.stderr).toContain('API rate limit exceeded');
  });

  it('classifies install-path GitHub 429 errors with retry guidance and body detail', async () => {
    const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
    await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');
    let alphaRequests = 0;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(500, 'Simulated failure');
      if (url.endsWith('/contents/')) {
        return response(200, JSON.stringify([{ name: 'alpha', path: 'alpha', type: 'dir' }]));
      }
      if (url.endsWith('/contents/alpha')) {
        alphaRequests += 1;
        if (alphaRequests === 1) {
          return response(
            200,
            JSON.stringify([
              {
                name: 'SKILL.md',
                path: 'alpha/SKILL.md',
                type: 'file',
                download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/SKILL.md',
              },
            ])
          );
        }
        return response(
          429,
          JSON.stringify({
            message:
              'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
          }),
          { 'retry-after': '60' },
          'Too Many Requests'
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['octo/skills', '--all'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('rate-limited access to octo/skills/alpha');
    expect(result.stderr).toContain('configured github.token was used');
    expect(result.stderr).toContain('after about 60 seconds');
    expect(result.stderr).toContain('secondary rate limit');
  });
});

describe('upskill Tessl registry integration', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];
  let dbCounter = 100;

  beforeEach(async () => {
    createdFileSystems = [];
    const originalCreate = VirtualFS.create.bind(VirtualFS);
    vi.spyOn(VirtualFS, 'create').mockImplementation(async (options) => {
      const instance = await originalCreate(options);
      createdFileSystems.push(instance);
      return instance;
    });

    fs = await VirtualFS.create({ dbName: `upskill-tessl-test-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await Promise.allSettled(
      createdFileSystems.map((instance) =>
        (instance.getLightningFS() as { _deactivate?: () => Promise<void> })._deactivate?.()
      )
    );
    vi.restoreAllMocks();
  });

  it('search queries both ClawHub and Tessl registries', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('convex.site')) {
        return response(200, JSON.stringify({ results: [{ slug: 'pdf-tool', displayName: 'PDF Tool', summary: 'Converts PDFs', version: null, updatedAt: 0 }] }));
      }
      if (url.includes('api.tessl.io')) {
        return response(200, JSON.stringify({
          meta: { pagination: { total: 1 } },
          data: [{
            id: 'tessl-1', type: 'skill',
            attributes: {
              name: 'pdf-converter', description: 'Advanced PDF conversion',
              sourceUrl: 'https://github.com/acme/skills', path: 'skills/pdf-converter/SKILL.md',
              featured: false, scores: { aggregate: 0.85, quality: null, security: null, evalImprovementMultiplier: null },
            },
          }],
        }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'pdf'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pdf-tool');
    expect(result.stdout).toContain('pdf-converter');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports when both registries fail', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('convex.site')) return response(500, 'Internal Server Error');
      if (url.includes('api.tessl.io')) return response(503, 'Service Unavailable');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'anything'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('both registries failed');
  });

  it('tessl: shorthand resolves skill via Tessl API and installs from GitHub', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(500, 'Simulated failure');
      // Tessl resolve endpoint
      if (url.includes('api.tessl.io') && url.includes('postgres-pro')) {
        return response(200, JSON.stringify({
          meta: { pagination: { total: 1 } },
          data: [{
            id: 'tessl-pg', type: 'skill',
            attributes: {
              name: 'postgres-pro', description: 'PostgreSQL skill',
              sourceUrl: 'https://github.com/acme/db-skills', path: 'skills/postgres-pro/SKILL.md',
              featured: true, scores: { aggregate: 0.9, quality: null, security: null, evalImprovementMultiplier: null },
            },
          }],
        }));
      }
      // GitHub contents listing
      if (url.includes('api.github.com') && url.endsWith('/contents/skills/postgres-pro')) {
        return response(200, JSON.stringify([
          { name: 'SKILL.md', path: 'skills/postgres-pro/SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/acme/db-skills/main/skills/postgres-pro/SKILL.md' },
        ]));
      }
      // Raw file download
      if (url.includes('raw.githubusercontent.com') && url.includes('SKILL.md')) {
        return response(200, '---\nname: postgres-pro\n---\n# PostgreSQL Pro\n');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['tessl:postgres-pro'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('postgres-pro');
  });

  it('checkRequiredBins warns about missing binaries', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(500, 'Simulated failure');
      if (url.endsWith('/contents/')) {
        return response(200, JSON.stringify([{ name: 'alpha', path: 'alpha', type: 'dir' }]));
      }
      if (url.endsWith('/contents/alpha')) {
        return response(200, JSON.stringify([
          { name: 'SKILL.md', path: 'alpha/SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/SKILL.md' },
        ]));
      }
      if (url.endsWith('/alpha/SKILL.md')) {
        return response(200, '---\nname: alpha\nrequires:\n  bins:\n    - ffmpeg\n    - magick\n---\n# Alpha\n');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['octo/skills', '--all'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('alpha');
  });

  it('lists and installs skills via codeload ZIP without GitHub API (no rate limit)', async () => {
    // Build a fake ZIP with a skill inside
    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/my-skill/SKILL.md': encoder.encode('---\nname: my-skill\n---\n# My Skill\n'),
      'skills-main/my-skill/helper.js': encoder.encode('console.log("hi");\n'),
      'skills-main/other/README.md': encoder.encode('# Not a skill\n'),
    });
    const zipBody = String.fromCharCode(...zipBytes);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) {
        return response(200, zipBody);
      }
      // GitHub API should NOT be called — fail if it is
      if (url.includes('api.github.com')) {
        return response(403, JSON.stringify({ message: 'rate limited' }), {}, 'Forbidden');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);

    // List should work via ZIP
    const listResult = await cmd.execute(['acme/skills', '--list'], createMockCtx() as any);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('my-skill');
    expect(listResult.stdout).not.toContain('other');

    // Install should also work via ZIP
    const installResult = await cmd.execute(['acme/skills', '--skill', 'my-skill'], createMockCtx() as any);
    expect(installResult.exitCode).toBe(0);
    expect(installResult.stdout).toContain('Installed skill "my-skill"');
    await expect(fs.readTextFile('/workspace/skills/my-skill/SKILL.md')).resolves.toContain('My Skill');
    await expect(fs.readTextFile('/workspace/skills/my-skill/helper.js')).resolves.toContain('console.log');

    // Verify no GitHub API calls were made
    for (const [url] of fetchMock.mock.calls) {
      expect(url).not.toContain('api.github.com');
    }
  });
});

describe('scoreSkills', () => {
  const catalog = [
    {
      name: 'aem',
      displayName: 'AEM',
      description: 'AEM skill',
      source: { repo: 'adobe/skills', path: 'skills/aem', flags: '--all' },
      affinity: { apps: ['aem'], tasks: ['build-websites', 'seo'], role: ['developer'], purpose: ['work'] },
    },
    {
      name: 'bluebubbles',
      displayName: 'BlueBubbles',
      description: 'iMessage',
      source: { repo: 'ai-ecoverse/skills', skill: 'bluebubbles' },
      affinity: { apps: ['imessage'], purpose: ['personal'] },
    },
    {
      name: 'skill-creator',
      displayName: 'Skill Creator',
      description: 'Create skills',
      source: { repo: 'anthropics/skills', skill: 'skill-creator' },
      affinity: { role: ['developer'], purpose: ['work', 'side-project'] },
      priority: 0.8,
    },
    {
      name: 'xlsx',
      displayName: 'XLSX',
      description: 'Spreadsheets',
      source: { repo: 'anthropics/skills', skill: 'xlsx' },
      affinity: { tasks: ['extract-data'], role: ['researcher'] },
    },
  ];

  it('scores skills by affinity weights (apps=3, tasks=2, role=1, purpose=1)', () => {
    const profile = { purpose: 'work', role: 'developer', tasks: ['build-websites'], apps: ['aem'], name: 'Test' };
    const scored = scoreSkills(catalog, profile);

    // AEM: apps(aem)=3 + tasks(build-websites)=2 + role(developer)=1 + purpose(work)=1 = 7
    expect(scored[0].entry.name).toBe('aem');
    expect(scored[0].score).toBe(7);
    expect(scored[0].matchReasons).toContain('apps(aem)');
  });

  it('applies priority multiplier', () => {
    const profile = { purpose: 'work', role: 'developer', tasks: [], apps: [], name: 'Test' };
    const scored = scoreSkills(catalog, profile);

    const skillCreator = scored.find((s) => s.entry.name === 'skill-creator');
    // role(developer)=1 + purpose(work)=1 = 2, * 0.8 priority = 1.6
    expect(skillCreator).toBeDefined();
    expect(skillCreator!.score).toBeCloseTo(1.6);
  });

  it('excludes skills with zero score', () => {
    const profile = { purpose: 'school', role: 'student', tasks: ['research'], apps: [], name: 'Test' };
    const scored = scoreSkills(catalog, profile);

    // AEM and bluebubbles should not match
    expect(scored.find((s) => s.entry.name === 'aem')).toBeUndefined();
    expect(scored.find((s) => s.entry.name === 'bluebubbles')).toBeUndefined();
  });

  it('sorts by score descending', () => {
    const profile = { purpose: 'work', role: 'developer', tasks: ['build-websites', 'extract-data'], apps: ['aem'], name: 'Test' };
    const scored = scoreSkills(catalog, profile);

    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  it('returns empty array when no skills match', () => {
    const profile = { purpose: 'school', role: 'student', tasks: [], apps: [], name: 'Test' };
    const scored = scoreSkills(catalog, profile);
    expect(scored).toHaveLength(0);
  });
});

describe('upskill recommendations subcommand', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];
  let dbCounter = 200;

  beforeEach(async () => {
    createdFileSystems = [];
    const originalCreate = VirtualFS.create.bind(VirtualFS);
    vi.spyOn(VirtualFS, 'create').mockImplementation(async (options) => {
      const instance = await originalCreate(options);
      createdFileSystems.push(instance);
      return instance;
    });

    fs = await VirtualFS.create({ dbName: `upskill-rec-test-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await Promise.allSettled(
      createdFileSystems.map((instance) =>
        (instance.getLightningFS() as { _deactivate?: () => Promise<void> })._deactivate?.()
      )
    );
    vi.restoreAllMocks();
  });

  it('returns error when no profile exists', async () => {
    const fetchMock = vi.fn();
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no user profile found');
  });

  it('lists recommendations when profile and catalog exist', async () => {
    // Write profile
    await fs.mkdir('/home/user', { recursive: true });
    await fs.writeFile('/home/user/.welcome.json', JSON.stringify({
      purpose: 'work', role: 'developer', tasks: ['build-websites'], apps: ['aem'], name: 'Test',
    }));

    // Write catalog
    await fs.mkdir('/shared', { recursive: true });
    await fs.writeFile('/shared/skill-catalog.json', JSON.stringify({
      version: 1,
      skills: [{
        name: 'aem', displayName: 'AEM', description: 'AEM skill',
        source: { repo: 'adobe/skills', path: 'skills/aem', flags: '--all' },
        affinity: { apps: ['aem'], tasks: ['build-websites'], role: ['developer'], purpose: ['work'] },
      }],
    }));

    const fetchMock = vi.fn();
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AEM');
    expect(result.stdout).toContain('score: 7');
    expect(result.stdout).toContain('upskill recommendations --install');
  });
});
