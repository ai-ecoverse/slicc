import 'fake-indexeddb/auto';

import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI, PageInfo } from '../../../../src/cdp/index.js';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetBrowseShCatalogCache,
  _resetGlobalFsCache,
  createUpskillCommand,
  normalizeHostname,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

let dbCounter = 0;

describe('normalizeHostname', () => {
  it('strips a single leading www. and lowercases', () => {
    expect(normalizeHostname('www.Weather.gov')).toBe('weather.gov');
    expect(normalizeHostname('WEATHER.GOV')).toBe('weather.gov');
    expect(normalizeHostname('weather.gov')).toBe('weather.gov');
  });

  it('does not strip non-www subdomains', () => {
    expect(normalizeHostname('api.weather.gov')).toBe('api.weather.gov');
    expect(normalizeHostname('www2.weather.gov')).toBe('www2.weather.gov');
  });
});

describe('upskill tabs', () => {
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
    fs = await VirtualFS.create({ dbName: `upskill-tabs-test-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    _resetBrowseShCatalogCache();
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
    vi.restoreAllMocks();
  });

  const TABS_CATALOG = [
    {
      slug: 'weather.gov/get-forecast-1uezib',
      hostname: 'weather.gov',
      task: 'get-forecast-1uezib',
      name: 'get-forecast',
      title: 'Get weather forecast',
      description: 'Fetch the latest forecast',
      tags: ['weather'],
      updated: '2026-04-01',
    },
  ];

  function makeBrowser(pages: PageInfo[]): BrowserAPI {
    return {
      listPages: vi.fn(async () => pages),
    } as unknown as BrowserAPI;
  }

  it('exits non-zero with a clear error when BrowserAPI is missing', async () => {
    const fetchMock = vi.fn();
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an empty listing when no tabs are open', async () => {
    const fetchMock = vi.fn();
    const browser = makeBrowser([]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No open browser tabs');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('matches browse.sh catalog entries by hostname (stripping www.)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: TABS_CATALOG }));
      }
      // Tab page fetch — no Link header.
      return response(200, '<html></html>', {});
    });
    const browser = makeBrowser([
      { targetId: 't1', title: 'Forecast', url: 'https://www.weather.gov/forecast', active: true },
    ]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Forecast');
    expect(result.stdout).toContain('Browse.sh catalog');
    expect(result.stdout).toContain('Get weather forecast');
    expect(result.stdout).toContain('upskill browse:weather.gov/get-forecast-1uezib');
    // Not installed → no checkmark prefix.
    expect(result.stdout).not.toContain('✓ Get weather forecast');
  });

  it('marks catalog matches installed when a matching skill directory exists', async () => {
    await fs.mkdir('/workspace/skills/browse-weather.gov-get-forecast', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/browse-weather.gov-get-forecast/SKILL.md',
      '---\nname: get-forecast\n---\n'
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: TABS_CATALOG }));
      }
      return response(200, '<html></html>', {});
    });
    const browser = makeBrowser([
      { targetId: 't1', title: 'Forecast', url: 'https://weather.gov/forecast' },
    ]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✓ Get weather forecast');
  });

  it('surfaces origin-advertised upskill rels from a tab Link header', async () => {
    const linkHeader =
      '<https://github.com/acme/skills>; rel="https://www.sliccy.ai/rel/upskill"; title="Acme skills"';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: [] }));
      }
      if (url === 'https://acme.example/docs') {
        return response(200, '<html></html>', { Link: linkHeader });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const browser = makeBrowser([
      { targetId: 't1', title: 'Acme', url: 'https://acme.example/docs' },
    ]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Origin-advertised');
    expect(result.stdout).toContain('upskill https://github.com/acme/skills');
    expect(result.stdout).toContain('Acme skills');
  });

  it('treats per-tab fetch failures as non-fatal and continues other tabs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: TABS_CATALOG }));
      }
      if (url === 'https://broken.example/') {
        throw new Error('network down');
      }
      return response(200, '<html></html>', {});
    });
    const browser = makeBrowser([
      { targetId: 't1', title: 'Broken', url: 'https://broken.example/' },
      { targetId: 't2', title: 'OK', url: 'https://weather.gov/forecast' },
    ]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('discovery failed');
    expect(result.stdout).toContain('network down');
    // Second tab still surfaces its catalog match.
    expect(result.stdout).toContain('Get weather forecast');
  });

  it('emits structured JSON when --json is passed', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: TABS_CATALOG }));
      }
      return response(200, '<html></html>', {});
    });
    const browser = makeBrowser([
      { targetId: 't1', title: 'Forecast', url: 'https://weather.gov/forecast', active: true },
    ]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs', '--json'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.tabs[0].hostname).toBe('weather.gov');
    expect(parsed.tabs[0].catalog).toHaveLength(1);
    expect(parsed.tabs[0].catalog[0].slug).toBe('weather.gov/get-forecast-1uezib');
    expect(parsed.tabs[0].catalog[0].installed).toBe(false);
    expect(parsed.tabs[0].active).toBe(true);
  });

  it('still surfaces origin rels when browse.sh catalog fetch fails', async () => {
    const linkHeader = '<https://github.com/acme/skills>; rel="https://www.sliccy.ai/rel/upskill"';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('browse.sh/api/skills')) {
        return response(503, 'Service Unavailable');
      }
      if (url === 'https://acme.example/') {
        return response(200, '<html></html>', { link: linkHeader });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const browser = makeBrowser([{ targetId: 't1', title: 'Acme', url: 'https://acme.example/' }]);
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch, browser);
    const result = await cmd.execute(['tabs'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('browse.sh catalog unavailable');
    expect(result.stdout).toContain('Origin-advertised');
    expect(result.stdout).toContain('upskill https://github.com/acme/skills');
  });
});
