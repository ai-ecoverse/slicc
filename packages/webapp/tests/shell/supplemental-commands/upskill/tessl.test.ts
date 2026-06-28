import 'fake-indexeddb/auto';

import { zipSync } from 'fflate';
import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetBrowseShCatalogCache,
  _resetGlobalFsCache,
  createUpskillCommand,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

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
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
    vi.restoreAllMocks();
  });

  it('search queries the Tessl registry', async () => {
    _resetBrowseShCatalogCache();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) {
        return response(
          200,
          JSON.stringify({
            meta: { pagination: { total: 1 } },
            data: [
              {
                id: 'tessl-1',
                type: 'skill',
                attributes: {
                  name: 'pdf-converter',
                  description: 'Advanced PDF conversion',
                  sourceUrl: 'https://github.com/acme/skills',
                  path: 'skills/pdf-converter/SKILL.md',
                  featured: false,
                  scores: {
                    aggregate: 0.85,
                    quality: null,
                    security: null,
                    evalImprovementMultiplier: null,
                  },
                },
              },
            ],
          })
        );
      }
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: [] }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'pdf'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pdf-converter');
    // Tessl + browse.sh catalog (browse.sh returns empty list for this query).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports when registries fail', async () => {
    _resetBrowseShCatalogCache();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) return response(503, 'Service Unavailable');
      if (url.includes('browse.sh/api/skills')) return response(503, 'Service Unavailable');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'anything'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('registries failed');
  });

  it('search emits per-source host-named warnings when a registry rejects', async () => {
    // Wave 13b: rejected fetches (network/CORS, not HTTP errors) must surface
    // a per-source `warning: <label> registry unavailable (<host>): ...` line
    // so users can see WHICH registry went down — not just "no results".
    _resetBrowseShCatalogCache();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('api.tessl.io')) throw new TypeError('Failed to fetch');
      if (url.includes('browse.sh/api/skills')) {
        return response(200, JSON.stringify({ skills: [] }));
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['search', 'anything'], createMockCtx() as any);

    expect(result.stderr).toContain('warning: Tessl registry unavailable');
    expect(result.stderr).toContain('api.tessl.io');
    // Mixed outcome (one source up, one down) → exit 0 with warnings.
    expect(result.exitCode).toBe(0);
  });

  it('tessl: shorthand resolves skill via Tessl API and installs from GitHub', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(500, 'Simulated failure');
      // Tessl resolve endpoint
      if (url.includes('api.tessl.io') && url.includes('postgres-pro')) {
        return response(
          200,
          JSON.stringify({
            meta: { pagination: { total: 1 } },
            data: [
              {
                id: 'tessl-pg',
                type: 'skill',
                attributes: {
                  name: 'postgres-pro',
                  description: 'PostgreSQL skill',
                  sourceUrl: 'https://github.com/acme/db-skills',
                  path: 'skills/postgres-pro/SKILL.md',
                  featured: true,
                  scores: {
                    aggregate: 0.9,
                    quality: null,
                    security: null,
                    evalImprovementMultiplier: null,
                  },
                },
              },
            ],
          })
        );
      }
      // GitHub contents listing
      if (url.includes('api.github.com') && url.endsWith('/contents/skills/postgres-pro')) {
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'skills/postgres-pro/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/acme/db-skills/main/skills/postgres-pro/SKILL.md',
            },
          ])
        );
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
      if (url.endsWith('/alpha/SKILL.md')) {
        return response(
          200,
          '---\nname: alpha\nrequires:\n  bins:\n    - ffmpeg\n    - magick\n---\n# Alpha\n'
        );
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
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) {
        return response(200, zipBytes);
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
    const installResult = await cmd.execute(
      ['acme/skills', '--skill', 'my-skill'],
      createMockCtx() as any
    );
    expect(installResult.exitCode).toBe(0);
    expect(installResult.stdout).toContain('Installed skill "my-skill"');
    await expect(fs.readTextFile('/workspace/skills/my-skill/SKILL.md')).resolves.toContain(
      'My Skill'
    );
    await expect(fs.readTextFile('/workspace/skills/my-skill/helper.js')).resolves.toContain(
      'console.log'
    );

    // Verify no GitHub API calls were made
    for (const [url] of fetchMock.mock.calls) {
      expect(url).not.toContain('api.github.com');
    }
  });

  it('GitHub owner/repo install does not contact api.tessl.io (decoupled)', async () => {
    // Wave 13b: confirm `upskill <owner/repo> --skill <name>` does not hard-depend
    // on the Tessl registry. A network outage on api.tessl.io must not block a
    // pure GitHub install via codeload.
    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/standalone/SKILL.md': encoder.encode(
        '---\nname: standalone\n---\n# Standalone\n'
      ),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      // Any Tessl call would simulate that host being down — install must still succeed.
      if (url.includes('api.tessl.io')) throw new TypeError('Failed to fetch');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['acme/skills', '--skill', 'standalone'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed skill "standalone"');
    for (const [url] of fetchMock.mock.calls) {
      expect(url).not.toContain('api.tessl.io');
    }
  });

  it('rejected fetch surfaces host-named error (no opaque "Failed to fetch")', async () => {
    // Wave 13b: a TypeError from the network layer must be wrapped with the
    // target host so the user can act on it. The Tessl resolver is the
    // narrowest fetch boundary exposed via the public CLI (`upskill tessl:<name>`).
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['tessl:postgres-pro'], createMockCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('api.tessl.io');
  });

  it('--path flag overrides URL-implicit /tree/<branch>/<path> sub-path at dispatch', async () => {
    // Code reading confirmed `effectiveSubPath = subPath ?? githubRef.path`,
    // i.e. an explicit --path wins over the implicit path baked into the URL.
    // This test locks that precedence in end-to-end through the command dispatcher:
    // the URL would naturally scope discovery to "implicit/", but --path "explicit"
    // must redirect it to the "explicit/" subtree.
    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/explicit/wanted/SKILL.md': encoder.encode('---\nname: wanted\n---\n# Wanted\n'),
      'skills-main/implicit/unwanted/SKILL.md': encoder.encode(
        '---\nname: unwanted\n---\n# Unwanted\n'
      ),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['https://github.com/acme/skills/tree/main/implicit', '--path', 'explicit', '--list'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('wanted');
    expect(result.stdout).not.toContain('unwanted');
  });

  it('calls __slicc_reloadSkills hook after successful install', async () => {
    const reloadSpy = vi.fn().mockResolvedValue(undefined);
    // reloadSkillsAfterInstall checks `typeof window !== 'undefined'` then
    // reads window.__slicc_reloadSkills. In Node/vitest window is globalThis.
    Object.defineProperty(globalThis, '__slicc_reloadSkills', {
      value: reloadSpy,
      writable: true,
      configurable: true,
    });

    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'skills-main/reload-skill/SKILL.md': encoder.encode(
        '---\nname: reload-skill\n---\n# Reload Skill\n'
      ),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) {
        return response(200, zipBytes);
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['acme/skills', '--skill', 'reload-skill'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(reloadSpy).toHaveBeenCalled();

    delete (globalThis as Record<string, unknown>).__slicc_reloadSkills;
  });

  it('falls back to Contents API when codeload returns 404 on --list', async () => {
    const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
    await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(404, '', {}, 'Not Found');
      if (url.endsWith('/contents/'))
        return response(
          200,
          JSON.stringify([{ name: 'private-skill', path: 'private-skill', type: 'dir' }])
        );
      if (url.includes('/contents/private-skill'))
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'private-skill/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/org/private-repo/main/private-skill/SKILL.md',
            },
          ])
        );
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['org/private-repo', '--list'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('private-skill');
  });

  it('falls back to Contents API when codeload returns 404 for a single skill install', async () => {
    const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
    await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(404, '', {}, 'Not Found');
      if (url.endsWith('/contents/'))
        return response(
          200,
          JSON.stringify([{ name: 'private-skill', path: 'private-skill', type: 'dir' }])
        );
      if (url.includes('/contents/private-skill'))
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'private-skill/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/org/private-repo/main/private-skill/SKILL.md',
            },
          ])
        );
      if (url.endsWith('/private-skill/SKILL.md')) return response(200, '# Private Skill\n');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['org/private-repo', '--skill', 'private-skill'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed skill "private-skill"');
    await expect(fs.readTextFile('/workspace/skills/private-skill/SKILL.md')).resolves.toContain(
      '# Private Skill'
    );
  });

  it('falls back to Contents API when codeload returns 404 for --all multi-skill install', async () => {
    const globalFs = await VirtualFS.create({ dbName: 'slicc-fs-global' });
    await globalFs.writeFile('/workspace/.git/github-token', 'ghp_test_token');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(404, '', {}, 'Not Found');
      if (url.endsWith('/contents/'))
        return response(
          200,
          JSON.stringify([
            { name: 'skill-a', path: 'skill-a', type: 'dir' },
            { name: 'skill-b', path: 'skill-b', type: 'dir' },
          ])
        );
      if (url.includes('/contents/skill-a'))
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'skill-a/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/org/private-repo/main/skill-a/SKILL.md',
            },
          ])
        );
      if (url.includes('/contents/skill-b'))
        return response(
          200,
          JSON.stringify([
            {
              name: 'SKILL.md',
              path: 'skill-b/SKILL.md',
              type: 'file',
              download_url:
                'https://raw.githubusercontent.com/org/private-repo/main/skill-b/SKILL.md',
            },
          ])
        );
      if (url.endsWith('/skill-a/SKILL.md')) return response(200, '# Skill A\n');
      if (url.endsWith('/skill-b/SKILL.md')) return response(200, '# Skill B\n');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['org/private-repo', '--all'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    await expect(fs.readTextFile('/workspace/skills/skill-a/SKILL.md')).resolves.toContain(
      '# Skill A'
    );
    await expect(fs.readTextFile('/workspace/skills/skill-b/SKILL.md')).resolves.toContain(
      '# Skill B'
    );
  });
});
