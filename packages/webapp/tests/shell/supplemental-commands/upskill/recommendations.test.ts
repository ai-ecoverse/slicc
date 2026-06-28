import 'fake-indexeddb/auto';

import { zipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetGlobalFsCache,
  createUpskillCommand,
  installRecommendedSkills,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

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
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
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
    // Write profile under user's name
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          }),
          headers: {},
        };
      }
      return { status: 404, body: '', headers: {} };
    });
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AEM');
    expect(result.stdout).toContain('score: 7');
    expect(result.stdout).toContain('upskill recommendations --install');
  });

  it('fetches the company-specific catalog when profile.company is set', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
        company: 'Adobe',
      })
    );

    const seen: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.endsWith('/skills/catalog.json')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          }),
          headers: {},
        };
      }
      if (url.endsWith('/skills/adobe.json')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                name: 'adobe-internal-tool',
                displayName: 'Adobe Internal Tool',
                description: 'Internal-only skill',
                repo: 'adobe/internal-skills',
                path: 'skills/internal',
                skill: 'internal',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          }),
          headers: {},
        };
      }
      return { status: 404, body: '', headers: {} };
    });
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(seen.some((u) => u.endsWith('/skills/adobe.json'))).toBe(true);
    expect(result.stdout).toContain('AEM');
    expect(result.stdout).toContain('Adobe Internal Tool');
  });

  it('falls back to base catalog when company catalog 404s', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
        company: 'Unknown Co',
      })
    );

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/skills/catalog.json')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          }),
          headers: {},
        };
      }
      return { status: 404, body: '', headers: {} };
    });
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('AEM');
  });

  it('skips company catalog fetch when company is empty', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
        company: '',
      })
    );

    const seen: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      seen.push(url);
      if (url.endsWith('/skills/catalog.json')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          }),
          headers: {},
        };
      }
      return { status: 404, body: '', headers: {} };
    });
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(seen.some((u) => u.includes('/skills/') && !u.endsWith('/catalog.json'))).toBe(false);
  });

  it('returns error when catalog fetch fails', async () => {
    // Write profile so we get past profile check
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    const fetchMock = vi.fn().mockImplementation(async () => {
      return { status: 500, body: 'Internal Server Error', headers: {} };
    });
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to fetch skill catalog');
    expect(result.stderr).toContain('sliccy.com/skills/catalog.json');
  });

  it('excludes already-installed skills from recommendations', async () => {
    // Write profile
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    // Create an installed skill directory
    await fs.mkdir('/workspace/skills/aem', { recursive: true });
    await fs.writeFile('/workspace/skills/aem/SKILL.md', '# AEM Skill\n');

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          }),
          headers: {},
        };
      }
      return { status: 404, body: '', headers: {} };
    });
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['recommendations'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    // AEM should be filtered out since it's already installed
    expect(result.stdout).toContain('all matching skills are already installed');
    expect(result.stdout).not.toContain('AEM');
  });
});

describe('installRecommendedSkills helper (no-shell entry point)', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];
  let dbCounter = 400;

  beforeEach(async () => {
    createdFileSystems = [];
    const originalCreate = VirtualFS.create.bind(VirtualFS);
    vi.spyOn(VirtualFS, 'create').mockImplementation(async (options) => {
      const instance = await originalCreate(options);
      createdFileSystems.push(instance);
      return instance;
    });

    fs = await VirtualFS.create({ dbName: `install-helper-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
    vi.restoreAllMocks();
  });

  it('returns skipped="no-profile" when /home is empty', async () => {
    const fetchMock = vi.fn();
    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBe('no-profile');
    expect(result.installedNames).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses an in-memory profileOverride without scanning /home', async () => {
    // /home is empty — without the override this would skip with no-profile.
    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/aem/SKILL.md': encoder.encode('---\nname: aem\n---\n# AEM\n'),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          })
        );
      }
      if (url.includes('codeload.github.com')) {
        return response(200, zipBytes);
      }
      if (url.includes('api.github.com')) {
        return response(403, JSON.stringify({ message: 'rate limited' }), {}, 'Forbidden');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch, {
      purpose: 'work',
      role: 'developer',
      tasks: ['build-websites'],
      apps: ['aem'],
    });
    expect(result.skipped).toBeNull();
    expect(result.installedNames).toEqual(['aem']);
  });

  it('returns skipped="catalog-fetch" when the catalog request fails', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({ purpose: 'work', role: 'developer', tasks: ['x'], apps: ['y'] })
    );

    const fetchMock = vi.fn().mockResolvedValue({
      status: 503,
      body: '',
      headers: {},
    });
    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBe('catalog-fetch');
    expect(result.errors[0]).toContain('failed to fetch skill catalog');
  });

  it('installs a recommended skill end-to-end and reports it in installedNames', async () => {
    // Profile that scores well against the catalog entry.
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/aem/SKILL.md': encoder.encode('---\nname: aem\n---\n# AEM\n'),
      'skills-main/aem/helper.js': encoder.encode('console.log("hi");\n'),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          })
        );
      }
      if (url.includes('codeload.github.com')) {
        return response(200, zipBytes);
      }
      if (url.includes('api.github.com')) {
        return response(403, JSON.stringify({ message: 'rate limited' }), {}, 'Forbidden');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBeNull();
    expect(result.installedNames).toEqual(['aem']);
    expect(result.errors).toEqual([]);
    await expect(fs.readTextFile('/workspace/skills/aem/SKILL.md')).resolves.toContain('# AEM');
  });

  it('returns skipped="all-installed" when every match is already on disk', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );
    await fs.mkdir('/workspace/skills/aem', { recursive: true });
    await fs.writeFile('/workspace/skills/aem/SKILL.md', '# AEM Skill\n');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          })
        );
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBe('all-installed');
    expect(result.installedNames).toEqual([]);
  });

  it('installs a whole bundle when catalog row sets installAll', async () => {
    // Profile picks up the migration bundle via tasks: ['build-websites'].
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/skills/migration/migrate-page/SKILL.md': encoder.encode(
        '---\nname: migrate-page\n---\n# Migrate Page\n'
      ),
      'skills-main/skills/migration/migrate-block/SKILL.md': encoder.encode(
        '---\nname: migrate-block\n---\n# Migrate Block\n'
      ),
      'skills-main/skills/migration/migrate-header/SKILL.md': encoder.encode(
        '---\nname: migrate-header\n---\n# Migrate Header\n'
      ),
      'skills-main/skills/migration/dismiss-overlays/SKILL.md': encoder.encode(
        '---\nname: dismiss-overlays\n---\n# Dismiss Overlays\n'
      ),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'migrate-page',
                displayName: 'AEM Page Import',
                description: 'Migration bundle',
                repo: 'aemcoder/skills',
                path: 'skills/migration/',
                skill: 'migrate-page',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
                installAll: 'true',
              },
            ],
          })
        );
      }
      if (url.includes('codeload.github.com')) {
        return response(200, zipBytes);
      }
      if (url.includes('api.github.com')) {
        return response(403, JSON.stringify({ message: 'rate limited' }), {}, 'Forbidden');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.installedNames.sort()).toEqual([
      'dismiss-overlays',
      'migrate-block',
      'migrate-header',
      'migrate-page',
    ]);
    await expect(fs.readTextFile('/workspace/skills/migrate-page/SKILL.md')).resolves.toContain(
      '# Migrate Page'
    );
    await expect(fs.readTextFile('/workspace/skills/migrate-block/SKILL.md')).resolves.toContain(
      '# Migrate Block'
    );
    await expect(fs.readTextFile('/workspace/skills/migrate-header/SKILL.md')).resolves.toContain(
      '# Migrate Header'
    );
    await expect(fs.readTextFile('/workspace/skills/dismiss-overlays/SKILL.md')).resolves.toContain(
      '# Dismiss Overlays'
    );
  });

  it('fills in missing companions when only some bundle skills are installed', async () => {
    // Pre-install ONE bundle skill — but NOT the primary `migrate-page`,
    // so the catalog filter doesn't drop the entry. The bundle install
    // should skip the already-installed companion and install the rest.
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );
    await fs.mkdir('/workspace/skills/migrate-block', { recursive: true });
    await fs.writeFile('/workspace/skills/migrate-block/SKILL.md', '# pre-existing\n');

    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/skills/migration/migrate-page/SKILL.md': encoder.encode(
        '---\nname: migrate-page\n---\n# Migrate Page\n'
      ),
      'skills-main/skills/migration/migrate-block/SKILL.md': encoder.encode(
        '---\nname: migrate-block\n---\n# Migrate Block (new)\n'
      ),
      'skills-main/skills/migration/migrate-header/SKILL.md': encoder.encode(
        '---\nname: migrate-header\n---\n# Migrate Header\n'
      ),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'migrate-page',
                displayName: 'AEM Page Import',
                description: 'Migration bundle',
                repo: 'aemcoder/skills',
                path: 'skills/migration/',
                skill: 'migrate-page',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
                installAll: 'true',
              },
            ],
          })
        );
      }
      if (url.includes('codeload.github.com')) {
        return response(200, zipBytes);
      }
      if (url.includes('api.github.com')) {
        return response(403, JSON.stringify({ message: 'rate limited' }), {}, 'Forbidden');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.installedNames.sort()).toEqual(['migrate-header', 'migrate-page']);
    // The pre-existing companion was left untouched.
    await expect(fs.readTextFile('/workspace/skills/migrate-block/SKILL.md')).resolves.toContain(
      'pre-existing'
    );
  });

  it('falls back to Contents API when codeload returns 404 for a recommended skill', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'aem',
                displayName: 'AEM',
                description: 'AEM skill',
                repo: 'adobe/skills',
                path: 'skills/aem',
                skill: 'aem',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
              },
            ],
          })
        );
      }
      if (url.includes('codeload.github.com')) return response(404, '', {}, 'Not Found');
      if (url.includes('/repos/adobe/skills/contents/skills/aem')) {
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'skills/aem/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/adobe/skills/main/skills/aem/SKILL.md',
            },
          ])
        );
      }
      if (url.endsWith('/skills/aem/SKILL.md')) {
        return response(200, '---\nname: aem\n---\n# AEM\n');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.installedNames).toEqual(['aem']);
    await expect(fs.readTextFile('/workspace/skills/aem/SKILL.md')).resolves.toContain('# AEM');
  });

  it('falls back to Contents API when codeload returns 404 for a recommended installAll bundle', async () => {
    await fs.mkdir('/home/test', { recursive: true });
    await fs.writeFile(
      '/home/test/.welcome.json',
      JSON.stringify({
        purpose: 'work',
        role: 'developer',
        tasks: ['build-websites'],
        apps: ['aem'],
        name: 'Test',
      })
    );

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/skills/catalog.json')) {
        return response(
          200,
          JSON.stringify({
            data: [
              {
                name: 'migrate-page',
                displayName: 'AEM Page Import',
                description: 'Migration bundle',
                repo: 'aemcoder/skills',
                path: 'skills/migration/',
                skill: 'migrate-page',
                apps: 'aem',
                tasks: 'build-websites',
                role: 'developer',
                purpose: 'work',
                boost: '',
                installAll: 'true',
              },
            ],
          })
        );
      }
      if (url.includes('codeload.github.com')) return response(404, '', {}, 'Not Found');
      if (url.includes('/repos/aemcoder/skills/contents/skills/migration/migrate-page')) {
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'skills/migration/migrate-page/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/aemcoder/skills/main/skills/migration/migrate-page/SKILL.md',
            },
          ])
        );
      }
      if (url.includes('/repos/aemcoder/skills/contents/skills/migration/migrate-header')) {
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'skills/migration/migrate-header/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/aemcoder/skills/main/skills/migration/migrate-header/SKILL.md',
            },
          ])
        );
      }
      if (url.includes('/repos/aemcoder/skills/contents/skills/migration')) {
        return response(
          200,
          JSON.stringify([
            { name: 'migrate-page', path: 'skills/migration/migrate-page', type: 'dir' },
            { name: 'migrate-header', path: 'skills/migration/migrate-header', type: 'dir' },
          ])
        );
      }
      if (url.endsWith('/skills/migration/migrate-page/SKILL.md')) {
        return response(200, '---\nname: migrate-page\n---\n# Migrate Page\n');
      }
      if (url.endsWith('/skills/migration/migrate-header/SKILL.md')) {
        return response(200, '---\nname: migrate-header\n---\n# Migrate Header\n');
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await installRecommendedSkills(fs, fetchMock as unknown as SecureFetch);
    expect(result.skipped).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.installedNames.sort()).toEqual(['migrate-header', 'migrate-page']);
    await expect(fs.readTextFile('/workspace/skills/migrate-page/SKILL.md')).resolves.toContain(
      '# Migrate Page'
    );
    await expect(fs.readTextFile('/workspace/skills/migrate-header/SKILL.md')).resolves.toContain(
      '# Migrate Header'
    );
  });
});
