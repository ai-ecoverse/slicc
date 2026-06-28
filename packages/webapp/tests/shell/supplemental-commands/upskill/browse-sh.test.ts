import 'fake-indexeddb/auto';

import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetBrowseShCatalogCache,
  _resetGlobalFsCache,
  createUpskillCommand,
  parseBrowseShRef,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

let dbCounter = 0;

describe('parseBrowseShRef', () => {
  it('parses browse: shorthand', () => {
    expect(parseBrowseShRef('browse:weather.gov/get-forecast-1uezib')).toEqual({
      hostname: 'weather.gov',
      task: 'get-forecast-1uezib',
    });
  });

  it('parses the canonical URL form', () => {
    expect(parseBrowseShRef('https://browse.sh/skills/weather.gov/get-forecast-1uezib')).toEqual({
      hostname: 'weather.gov',
      task: 'get-forecast-1uezib',
    });
  });

  it('accepts a trailing slash on the URL form', () => {
    expect(parseBrowseShRef('https://browse.sh/skills/weather.gov/get-forecast-1uezib/')).toEqual({
      hostname: 'weather.gov',
      task: 'get-forecast-1uezib',
    });
  });

  it('rejects path traversal', () => {
    expect(parseBrowseShRef('browse:../etc/passwd')).toBeNull();
    expect(parseBrowseShRef('browse:weather.gov/../etc')).toBeNull();
  });

  it('rejects dot and dot-dot segments outright', () => {
    // Single-dot segments — the BROWSE_SH_SEGMENT_RE allowlist accepts `.`
    // characters inside a longer segment, so these have to be rejected by
    // the explicit `.` / `..` check.
    expect(parseBrowseShRef('browse:./forecast')).toBeNull();
    expect(parseBrowseShRef('browse:weather.gov/.')).toBeNull();
    expect(parseBrowseShRef('browse:../forecast')).toBeNull();
    expect(parseBrowseShRef('browse:weather.gov/..')).toBeNull();
    expect(parseBrowseShRef('browse:./.')).toBeNull();
    expect(parseBrowseShRef('browse:../..')).toBeNull();
    // URL form must reject the same shapes.
    expect(parseBrowseShRef('https://browse.sh/skills/./forecast')).toBeNull();
    expect(parseBrowseShRef('https://browse.sh/skills/weather.gov/.')).toBeNull();
    expect(parseBrowseShRef('https://browse.sh/skills/../etc')).toBeNull();
    expect(parseBrowseShRef('https://browse.sh/skills/weather.gov/..')).toBeNull();
  });

  it('rejects empty hostname or task segments', () => {
    expect(parseBrowseShRef('browse:/task')).toBeNull();
    expect(parseBrowseShRef('browse:host/')).toBeNull();
    expect(parseBrowseShRef('browse:/')).toBeNull();
  });

  it('rejects missing segments', () => {
    expect(parseBrowseShRef('browse:weather.gov')).toBeNull();
    expect(parseBrowseShRef('browse:/get-forecast')).toBeNull();
    expect(parseBrowseShRef('browse:')).toBeNull();
  });

  it('rejects extra path segments', () => {
    expect(parseBrowseShRef('browse:weather.gov/get/forecast')).toBeNull();
  });

  it('normalizes hostname to lowercase and strips a leading www.', () => {
    // Matches the rest of the browse.sh install/match logic, which compares
    // against `normalizeHostname` output.
    expect(parseBrowseShRef('browse:WEATHER.GOV/get-forecast')).toEqual({
      hostname: 'weather.gov',
      task: 'get-forecast',
    });
    expect(parseBrowseShRef('browse:www.weather.gov/get-forecast')).toEqual({
      hostname: 'weather.gov',
      task: 'get-forecast',
    });
    expect(parseBrowseShRef('https://browse.sh/skills/WWW.Weather.GOV/get-forecast')).toEqual({
      hostname: 'weather.gov',
      task: 'get-forecast',
    });
  });

  it('returns null for unrelated refs', () => {
    expect(parseBrowseShRef('owner/repo')).toBeNull();
    expect(parseBrowseShRef('tessl:postgres-pro')).toBeNull();
    expect(parseBrowseShRef('https://github.com/owner/repo')).toBeNull();
  });
});

describe('upskill browse.sh registry integration', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];

  beforeEach(async () => {
    _resetBrowseShCatalogCache();
    createdFileSystems = [];
    const originalCreate = VirtualFS.create.bind(VirtualFS);
    vi.spyOn(VirtualFS, 'create').mockImplementation(async (options) => {
      const instance = await originalCreate(options);
      createdFileSystems.push(instance);
      return instance;
    });

    fs = await VirtualFS.create({ dbName: `upskill-browseSh-test-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    _resetBrowseShCatalogCache();
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
    vi.restoreAllMocks();
  });

  const SAMPLE_CATALOG = [
    {
      slug: 'weather.gov/get-forecast-1uezib',
      hostname: 'weather.gov',
      task: 'get-forecast-1uezib',
      name: 'get-forecast',
      title: 'Get weather forecast',
      description: 'Fetch the latest forecast from weather.gov',
      tags: ['weather', 'noaa'],
      updated: '2026-04-01',
    },
    {
      slug: 'example.com/login-abc123',
      hostname: 'example.com',
      task: 'login-abc123',
      name: 'login',
      title: 'Log into example.com',
      description: 'Sign in to the example portal',
      tags: ['auth'],
      updated: '2026-04-02',
    },
  ];

  const UPSTREAM_SKILL_MD = [
    '---',
    'name: get-forecast',
    'description: Fetch the latest forecast from weather.gov',
    '---',
    '',
    '# Get the weather forecast',
    '',
    'Open weather.gov and read the forecast.',
    '',
  ].join('\n');

  it('search merges browse.sh hits with Tessl results', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) {
        return response(200, JSON.stringify({ meta: { pagination: { total: 0 } }, data: [] }));
      }
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: SAMPLE_CATALOG }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'weather'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('weather.gov/get-forecast-1uezib');
    expect(result.stdout).toContain('[browseSh]');
    // Description should appear in the rendered listing
    expect(result.stdout).toContain('Fetch the latest forecast');
  });

  it('search filters the cached browse.sh catalog client-side', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) {
        return response(200, JSON.stringify({ meta: { pagination: { total: 0 } }, data: [] }));
      }
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: SAMPLE_CATALOG }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'login'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('example.com/login-abc123');
    expect(result.stdout).not.toContain('weather.gov/get-forecast');
  });

  it('installs a browse.sh skill via the blob URL and preserves upstream bytes around the preamble', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://browse.sh/api/skills/weather.gov/get-forecast-1uezib') {
        return response(
          200,
          JSON.stringify({
            slug: 'weather.gov/get-forecast-1uezib',
            hostname: 'weather.gov',
            task: 'get-forecast-1uezib',
            name: 'get-forecast',
            title: 'Get weather forecast',
            description: 'Fetch the latest forecast',
            updated: '2026-04-01',
            skillMdUrl: 'https://blob.vercel-storage.com/skill.md',
            skillMd: 'INLINE — should not be used when blob is reachable',
          })
        );
      }
      if (url === 'https://blob.vercel-storage.com/skill.md') {
        return response(200, UPSTREAM_SKILL_MD);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['browse:weather.gov/get-forecast-1uezib'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed skill "browse-weather.gov-get-forecast"');

    const installed = await fs.readTextFile(
      '/workspace/skills/browse-weather.gov-get-forecast/SKILL.md'
    );

    // Frontmatter is the very first thing in the file (must remain valid).
    expect(installed.startsWith('---\n')).toBe(true);

    // The frontmatter must round-trip byte-identical.
    expect(installed).toContain(
      '---\nname: get-forecast\ndescription: Fetch the latest forecast from weather.gov\n---\n'
    );

    // The SLICC preamble lands BELOW the frontmatter and ABOVE the body.
    expect(installed).toContain('Imported from browse.sh');
    expect(installed).toContain('playwright-cli');
    expect(installed).toContain('weather.gov/get-forecast-1uezib');
    const preambleIdx = installed.indexOf('Imported from browse.sh');
    const fmCloseIdx = installed.indexOf('---\n', 4);
    const bodyIdx = installed.indexOf('# Get the weather forecast');
    expect(fmCloseIdx).toBeGreaterThan(0);
    expect(preambleIdx).toBeGreaterThan(fmCloseIdx);
    expect(bodyIdx).toBeGreaterThan(preambleIdx);

    // The upstream body remains byte-identical.
    expect(installed).toContain(
      '# Get the weather forecast\n\nOpen weather.gov and read the forecast.\n'
    );
  });

  it('URL form installs the same skill as the browse: shorthand', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://browse.sh/api/skills/weather.gov/get-forecast-1uezib') {
        return response(
          200,
          JSON.stringify({
            slug: 'weather.gov/get-forecast-1uezib',
            hostname: 'weather.gov',
            task: 'get-forecast-1uezib',
            name: 'get-forecast',
            skillMd: UPSTREAM_SKILL_MD,
          })
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['https://browse.sh/skills/weather.gov/get-forecast-1uezib'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    await expect(
      fs.readTextFile('/workspace/skills/browse-weather.gov-get-forecast/SKILL.md')
    ).resolves.toContain('Get the weather forecast');
  });

  it('falls back to inline skillMd when the blob fetch fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://browse.sh/api/skills/weather.gov/get-forecast-1uezib') {
        return response(
          200,
          JSON.stringify({
            slug: 'weather.gov/get-forecast-1uezib',
            hostname: 'weather.gov',
            task: 'get-forecast-1uezib',
            name: 'get-forecast',
            skillMdUrl: 'https://blob.vercel-storage.com/skill.md',
            skillMd: UPSTREAM_SKILL_MD,
          })
        );
      }
      if (url === 'https://blob.vercel-storage.com/skill.md') {
        return response(500, 'Internal Server Error');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['browse:weather.gov/get-forecast-1uezib'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    await expect(
      fs.readTextFile('/workspace/skills/browse-weather.gov-get-forecast/SKILL.md')
    ).resolves.toContain('# Get the weather forecast');
  });

  it('refuses to overwrite an existing install without --force', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://browse.sh/api/skills/weather.gov/get-forecast-1uezib') {
        return response(
          200,
          JSON.stringify({
            slug: 'weather.gov/get-forecast-1uezib',
            hostname: 'weather.gov',
            task: 'get-forecast-1uezib',
            name: 'get-forecast',
            skillMd: UPSTREAM_SKILL_MD,
          })
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const first = await cmd.execute(
      ['browse:weather.gov/get-forecast-1uezib'],
      createMockCtx() as any
    );
    expect(first.exitCode).toBe(0);

    const second = await cmd.execute(
      ['browse:weather.gov/get-forecast-1uezib'],
      createMockCtx() as any
    );
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('already exists');
    expect(second.stderr).toContain('--force');

    const forced = await cmd.execute(
      ['browse:weather.gov/get-forecast-1uezib', '--force'],
      createMockCtx() as any
    );
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain('Installed skill');
  });

  it('reports a 404 from browse.sh as a clean install error', async () => {
    const fetchMock = vi.fn(async () => response(404, '{"error":"not found"}'));

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['browse:weather.gov/missing'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browse.sh');
    expect(result.stderr).toContain('not found');
  });

  it('search round-robin interleaves Tessl and browse.sh hits (1T, 1B, 2T, 2B, …)', async () => {
    // Three matches per source — enough to expose any per-source concatenation.
    const tesslSkills = ['weather-tessl-1', 'weather-tessl-2', 'weather-tessl-3'].map(
      (name, i) => ({
        id: `tessl-${i + 1}`,
        type: 'skill',
        attributes: {
          name,
          description: `Tessl skill ${i + 1}`,
          // Distinct sourceUrls — fetchTesslResults dedups by `sourceUrl`,
          // so identical URLs would collapse the three Tessl rows into one
          // and the interleaving assertion would silently degrade.
          sourceUrl: `https://github.com/acme/${name}`,
          path: `skills/${name}/SKILL.md`,
          featured: false,
          scores: {
            aggregate: 0.9 - i * 0.1,
            quality: null,
            security: null,
            evalImprovementMultiplier: null,
          },
        },
      })
    );
    const browseSkills = ['get-forecast-aaa', 'get-radar-bbb', 'get-alerts-ccc'].map((task, i) => ({
      slug: `weather.gov/${task}`,
      hostname: 'weather.gov',
      task,
      name: task.replace(/-[a-z]+$/, ''),
      title: `Browse skill ${i + 1} for weather`,
      description: `Browse-weather variant ${i + 1}`,
      tags: ['weather'],
      updated: '2026-04-01',
    }));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) {
        return response(
          200,
          JSON.stringify({ meta: { pagination: { total: tesslSkills.length } }, data: tesslSkills })
        );
      }
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: browseSkills }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'weather'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    // Locate each display name in stdout and assert strict round-robin order:
    // Tessl[0], browse.sh[0], Tessl[1], browse.sh[1], Tessl[2], browse.sh[2].
    const positions = [
      result.stdout.indexOf('weather-tessl-1'),
      result.stdout.indexOf('weather.gov/get-forecast-aaa'),
      result.stdout.indexOf('weather-tessl-2'),
      result.stdout.indexOf('weather.gov/get-radar-bbb'),
      result.stdout.indexOf('weather-tessl-3'),
      result.stdout.indexOf('weather.gov/get-alerts-ccc'),
    ];
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('No skills found hint mentions both registries', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) {
        return response(200, JSON.stringify({ meta: { pagination: { total: 0 } }, data: [] }));
      }
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: [] }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'nothingmatches'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No skills found');
    expect(result.stdout).toContain('tessl.io/registry');
    expect(result.stdout).toContain('browse.sh');
  });

  it('refuses to install when upstream frontmatter declares an unsafe name', async () => {
    const unsafeNames = [
      'foo/../../shared', // path traversal via separator
      '..', // bare dot-dot
      '.', // bare dot
      '/etc/passwd', // absolute path
      'has space', // shell metachar
      'a'.repeat(65), // over the 64-char cap
    ];

    for (const unsafe of unsafeNames) {
      _resetBrowseShCatalogCache();
      const skillMd = ['---', `name: ${unsafe}`, 'description: unsafe', '---', '', '# body'].join(
        '\n'
      );
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'https://browse.sh/api/skills/weather.gov/get-forecast-1uezib') {
          return response(
            200,
            JSON.stringify({
              slug: 'weather.gov/get-forecast-1uezib',
              hostname: 'weather.gov',
              task: 'get-forecast-1uezib',
              name: 'get-forecast',
              skillMd,
            })
          );
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
      const result = await cmd.execute(
        ['browse:weather.gov/get-forecast-1uezib'],
        createMockCtx() as any
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('unsafe name');
      // Nothing escaped the skills root.
      await expect(fs.stat('/workspace/skills/browse-weather.gov')).rejects.toBeTruthy();
      await expect(fs.stat('/etc/passwd')).rejects.toBeTruthy();
      await expect(fs.stat('/shared')).rejects.toBeTruthy();
    }
  });
});
