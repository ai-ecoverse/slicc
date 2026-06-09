import 'fake-indexeddb/auto';

import { zipSync } from 'fflate';
import type { IFileSystem, SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI, PageInfo } from '../../../src/cdp/index.js';
import { VirtualFS } from '../../../src/fs/index.js';
import {
  _resetBrowseShCatalogCache,
  _resetGlobalFsCache,
  createSkillCommand,
  createUpskillCommand,
  installRecommendedSkills,
  normalizeHostname,
  parseBrowseShRef,
  parseGitHubRef,
  scoreSkills,
} from '../../../src/shell/supplemental-commands/upskill-command.js';

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
  body: string | Uint8Array,
  headers: Record<string, string> = {},
  statusText = ''
) {
  return {
    status,
    statusText,
    headers,
    body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    url: 'https://example.test',
  };
}

let dbCounter = 0;
describe('parseGitHubRef', () => {
  it('parses bare owner/repo', () => {
    expect(parseGitHubRef('owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: undefined,
    });
  });

  it('parses owner/repo@branch', () => {
    expect(parseGitHubRef('owner/repo@dev')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'dev',
    });
  });

  it('parses plain GitHub URL', () => {
    expect(parseGitHubRef('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: undefined,
      path: undefined,
    });
  });

  it('parses GitHub URL with .git suffix', () => {
    expect(parseGitHubRef('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: undefined,
      path: undefined,
    });
  });

  it('parses GitHub URL with /tree/<branch>', () => {
    expect(parseGitHubRef('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: undefined,
    });
  });

  it('parses GitHub URL with /tree/<branch>/<deep/sub/path>', () => {
    expect(parseGitHubRef('https://github.com/owner/repo/tree/main/skills/foo/bar')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'skills/foo/bar',
    });
  });

  it('parses GitHub URL with trailing slash', () => {
    expect(parseGitHubRef('https://github.com/owner/repo/tree/main/skills/foo/')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'skills/foo',
    });
  });

  it('returns null for invalid input', () => {
    expect(parseGitHubRef('not a ref')).toBeNull();
    expect(parseGitHubRef('https://example.com/owner/repo')).toBeNull();
    expect(parseGitHubRef('')).toBeNull();
  });

  it('rejects http:// (https-only)', () => {
    // Avoid silently installing a skill fetched over plaintext where
    // a network attacker could substitute the response.
    expect(parseGitHubRef('http://github.com/owner/repo')).toBeNull();
  });

  it('rejects typosquat hosts (locks in security invariant)', () => {
    // Path-segment squat: github.com appears as a path segment, not the host.
    expect(parseGitHubRef('https://evil.com/github.com/owner/repo')).toBeNull();
    // Suffix squat: host starts with github.com but has extra TLD labels.
    expect(parseGitHubRef('https://github.com.evil.com/owner/repo')).toBeNull();
    // Adjacent-TLD squat: github.co is a different host from github.com.
    expect(parseGitHubRef('https://github.co/owner/repo')).toBeNull();
  });
});

describe('skill/upskill command compatibility discovery', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-upskill-command-${dbCounter++}`,
      wipe: true,
    });
  });

  afterEach(() => {
    _resetGlobalFsCache();
  });

  it('skill help documents discoverable compatibility roots', async () => {
    const result = await createSkillCommand(fs).execute(['--help'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('List discoverable skills');
    expect(result.stdout).toContain('**/.agents/skills/*');
    expect(result.stdout).toContain('**/.claude/skills/*');
    // The `upskill search` line must list every registry the search actually
    // queries (Tessl + browse.sh), not just one of them — see PR #707 thread.
    expect(result.stdout).toMatch(/upskill search.*Tessl.*browse\.sh/);
    expect(result.stdout).toContain('browse:<host>/<task>');
  });

  it('skill list shows source and description for both native and compatibility skills', async () => {
    await fs.mkdir('/workspace/skills/native-skill', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/native-skill/SKILL.md',
      '---\nname: native-skill\ndescription: Native skill\n---\n# Native\n'
    );

    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', '# Compat Skill');

    const result = await createSkillCommand(fs).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable skills:');
    expect(result.stdout).toContain('native-skill');
    expect(result.stdout).toContain('compat-skill');
    expect(result.stdout).toContain('native');
    expect(result.stdout).toContain('.claude');
  });

  it('skill info reports source for compatibility skills', async () => {
    await fs.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/agent-skill/SKILL.md', '# Agent Skill');

    const result = await createSkillCommand(fs).execute(
      ['info', 'agent-skill'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skill: agent-skill');
    expect(result.stdout).toContain('Source: .agents');
    expect(result.stdout).toContain('Source root: /repo/.agents/skills');
    expect(result.stdout).toContain('Instructions: /repo/.agents/skills/agent-skill/SKILL.md');
  });

  it('skill install/uninstall subcommands no longer exist', async () => {
    const installResult = await createSkillCommand(fs).execute(
      ['install', 'anything'],
      createMockCtx() as never
    );
    expect(installResult.exitCode).toBe(1);
    expect(installResult.stderr).toContain('unknown command');

    const uninstallResult = await createSkillCommand(fs).execute(
      ['uninstall', 'anything'],
      createMockCtx() as never
    );
    expect(uninstallResult.exitCode).toBe(1);
    expect(uninstallResult.stderr).toContain('unknown command');
  });

  it('upskill list uses unified local discovery wording', async () => {
    await fs.mkdir('/repo/.agents/skills/local-agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/local-agent-skill/SKILL.md', '# Local Agent Skill');

    const result = await createUpskillCommand(fs, vi.fn() as never).execute(
      ['list'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable local skills:');
    expect(result.stdout).toContain('local-agent-skill');
    expect(result.stdout).toContain('.agents');
  });

  it('skill list shows marketplace as source for marketplace skills', async () => {
    // Set up a marketplace plugin: a .claude-plugin/marketplace.json that points
    // to a local plugin directory containing a skills sub-tree.
    await fs.mkdir('/repo/.claude-plugin', { recursive: true });
    await fs.writeFile(
      '/repo/.claude-plugin/marketplace.json',
      JSON.stringify({ plugins: [{ source: './plugins/market-tools' }] })
    );
    await fs.mkdir('/repo/plugins/market-tools/skills/my-market-skill', { recursive: true });
    await fs.writeFile(
      '/repo/plugins/market-tools/skills/my-market-skill/SKILL.md',
      '---\nname: my-market-skill\ndescription: A marketplace skill\n---\n# My Market Skill\n'
    );

    const result = await createSkillCommand(fs).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('my-market-skill');
    expect(result.stdout).toContain('marketplace');
  });

  it('skill info shows Source: marketplace for marketplace skill', async () => {
    // Same marketplace layout: .claude-plugin/marketplace.json points to a local plugin dir.
    await fs.mkdir('/repo/.claude-plugin', { recursive: true });
    await fs.writeFile(
      '/repo/.claude-plugin/marketplace.json',
      JSON.stringify({ plugins: [{ source: './plugins/market-tools' }] })
    );
    await fs.mkdir('/repo/plugins/market-tools/skills/my-market-skill', { recursive: true });
    await fs.writeFile(
      '/repo/plugins/market-tools/skills/my-market-skill/SKILL.md',
      '---\nname: my-market-skill\ndescription: A marketplace skill\n---\n# My Market Skill\n'
    );

    const result = await createSkillCommand(fs).execute(
      ['info', 'my-market-skill'],
      createMockCtx() as never
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skill: my-market-skill');
    expect(result.stdout).toContain('Source: marketplace');
  });
});

describe('upskill command GitHub flows', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];

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
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
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

describe('scoreSkills', () => {
  const catalog = [
    {
      name: 'aem',
      displayName: 'AEM',
      description: 'AEM skill',
      source: { repo: 'adobe/skills', path: 'skills/aem', skill: 'aem' },
      affinity: {
        apps: ['aem'],
        tasks: ['build-websites', 'seo'],
        role: ['developer'],
        purpose: ['work'],
      },
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
    const profile = {
      purpose: 'work',
      role: 'developer',
      tasks: ['build-websites'],
      apps: ['aem'],
      name: 'Test',
    };
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
    const profile = {
      purpose: 'school',
      role: 'student',
      tasks: ['research'],
      apps: [],
      name: 'Test',
    };
    const scored = scoreSkills(catalog, profile);

    // AEM and bluebubbles should not match
    expect(scored.find((s) => s.entry.name === 'aem')).toBeUndefined();
    expect(scored.find((s) => s.entry.name === 'bluebubbles')).toBeUndefined();
  });

  it('sorts by score descending', () => {
    const profile = {
      purpose: 'work',
      role: 'developer',
      tasks: ['build-websites', 'extract-data'],
      apps: ['aem'],
      name: 'Test',
    };
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

// Shell-injection defense (defense-in-depth at the receiver).
//
// `handoff-link.ts` drops unsafe branch/path Link params at extraction
// so the cone never sees them in the navigate-lick body. These tests
// pin the second gate: even if a future dispatch path bypassed the
// extractor and handed the upskill command a literal injection
// payload, the command itself refuses the value with a clear error
// and never reaches the GitHub flow. Fetch is asserted untouched so
// any code path that bypassed validation would visibly regress the
// "no network call on rejection" assertion.
describe('upskill command — shell-injection defense', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `upskill-injection-${dbCounter++}`, wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await fs.dispose();
    vi.restoreAllMocks();
  });

  // Adversarial branch values. Each one should be rejected before any
  // network call, with a clear stderr message and exitCode 1.
  const BRANCH_VECTORS: Array<[label: string, value: string]> = [
    ['semicolon', 'main;rm -rf /'],
    ['backtick', 'main`whoami`'],
    ['command-substitution', 'main$(whoami)'],
    ['trailing-newline', 'main\necho PWNED'],
    ['leading-dash', '-rf'],
    ['double-dot-traversal', '../etc/passwd'],
    ['space', 'main release'],
    ['pipe', 'main|cat /etc/passwd'],
  ];

  for (const [label, value] of BRANCH_VECTORS) {
    it(`rejects --branch with ${label} (no network call)`, async () => {
      const fetchMock = vi.fn();
      const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
      const result = await cmd.execute(['--branch', value, 'owner/repo'], createMockCtx() as never);
      expect(result.exitCode).toBe(1);
      // The pre-existing "starts with -" check fires first for the
      // leading-dash vector ("--branch requires a value"); the new
      // allowlist check fires for everything else. Both are valid
      // rejections — the contract under test is "rejected with no
      // network call", not which message wins. Assert at least one of
      // the two known rejection messages is present.
      expect(result.stderr).toMatch(/--branch (must be a git ref|requires a value)/);
      // The whole point: no GitHub fetch fired with adversarial input.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  // Adversarial path values. Same shape as the branch vectors.
  const PATH_VECTORS: Array<[label: string, value: string]> = [
    ['semicolon', 'skills/foo;rm -rf /'],
    ['backtick', 'skills/`id`'],
    ['command-substitution', 'skills/$(id)'],
    ['trailing-newline', 'skills/foo\necho PWNED'],
    ['leading-dash', '-rf'],
    ['absolute-path', '/etc/passwd'],
    ['double-dot-traversal', '../etc/passwd'],
    ['embedded-double-dot', 'skills/../etc/passwd'],
    ['space', 'skills/foo bar'],
  ];

  for (const [label, value] of PATH_VECTORS) {
    it(`rejects --path with ${label} (no network call)`, async () => {
      const fetchMock = vi.fn();
      const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
      const result = await cmd.execute(['--path', value, 'owner/repo'], createMockCtx() as never);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--path must be a repo-relative sub-path');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it('accepts a normal --branch and --path combination', async () => {
    // Stub the GitHub flow with a 404 so we exercise the validation path
    // without standing up a full GitHub fixture. The point of this test
    // is that the validation gate did NOT short-circuit before the GitHub
    // call — i.e. benign inputs flow through unchanged.
    const fetchMock = vi.fn(async () =>
      response(404, JSON.stringify({ message: 'Not Found' }), {}, 'Not Found')
    );
    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['--branch', 'release/v1.2_hotfix-3', '--path', 'skills/foo_bar', 'owner/repo'],
      createMockCtx() as never
    );
    // Exit code is non-zero because the stub returns 404, but the
    // validation gate accepted the inputs and the GitHub fetch fired.
    expect(fetchMock).toHaveBeenCalled();
    expect(result.stderr).not.toContain('--branch must be a git ref');
    expect(result.stderr).not.toContain('--path must be a repo-relative sub-path');
  });
});

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

describe('upskill command — marketplace manifest flows', () => {
  let fs: VirtualFS;
  let createdFileSystems: VirtualFS[];
  let dbCounter = 700;

  beforeEach(async () => {
    createdFileSystems = [];
    const originalCreate = VirtualFS.create.bind(VirtualFS);
    vi.spyOn(VirtualFS, 'create').mockImplementation(async (options) => {
      const instance = await originalCreate(options);
      createdFileSystems.push(instance);
      return instance;
    });
    fs = await VirtualFS.create({ dbName: `upskill-marketplace-${dbCounter++}`, wipe: true });
    await VirtualFS.create({ dbName: 'slicc-fs-global', wipe: true });
  });

  afterEach(async () => {
    _resetGlobalFsCache();
    await Promise.allSettled(createdFileSystems.map((instance) => instance.dispose()));
    vi.restoreAllMocks();
  });

  function makeMarketplaceZip(opts: {
    marketplaceName?: string;
    version?: string;
    plugins: Array<{
      name: string;
      source: string | Record<string, unknown>;
      skills?: string[];
    }>;
  }): Uint8Array {
    const encoder = new TextEncoder();
    const manifest = {
      name: opts.marketplaceName ?? 'test-marketplace',
      metadata: { version: opts.version ?? '1.0.0' },
      plugins: opts.plugins.map((p) => ({
        name: p.name,
        description: `${p.name} plugin`,
        source: p.source,
        strict: false,
      })),
    };
    const entries: Record<string, Uint8Array> = {
      'repo-main/.claude-plugin/marketplace.json': encoder.encode(JSON.stringify(manifest)),
    };
    for (const plugin of opts.plugins) {
      if (typeof plugin.source !== 'string') continue;
      const pluginPath = plugin.source.replace(/^\.\//, '');
      for (const skillName of plugin.skills ?? []) {
        entries[`repo-main/${pluginPath}/skills/${skillName}/SKILL.md`] = encoder.encode(
          `---\nname: ${skillName}\n---\n# ${skillName}\n`
        );
      }
    }
    return zipSync(entries);
  }

  it('shows grouped marketplace listing when manifest is present', async () => {
    const zipBytes = makeMarketplaceZip({
      marketplaceName: 'my-marketplace',
      version: '2.0.0',
      plugins: [
        {
          name: 'tool-set-a',
          source: './plugins/tool-set-a',
          skills: ['skill-alpha', 'skill-beta'],
        },
        { name: 'tool-set-b', source: './plugins/tool-set-b', skills: ['skill-gamma'] },
      ],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['owner/repo'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('my-marketplace');
    expect(result.stdout).toContain('2.0.0');
    expect(result.stdout).toContain('tool-set-a');
    expect(result.stdout).toContain('skill-alpha');
    expect(result.stdout).toContain('skill-beta');
    expect(result.stdout).toContain('tool-set-b');
    expect(result.stdout).toContain('skill-gamma');
    expect(result.stdout).toContain('--plugin');
    expect(result.stdout).toContain('--skill');
    expect(result.stdout).toContain('--all');
  });

  it('--plugin installs all skills in a named collection', async () => {
    const zipBytes = makeMarketplaceZip({
      plugins: [
        {
          name: 'tool-set-a',
          source: './plugins/tool-set-a',
          skills: ['skill-alpha', 'skill-beta'],
        },
        { name: 'tool-set-b', source: './plugins/tool-set-b', skills: ['skill-gamma'] },
      ],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['owner/repo', '--plugin', 'tool-set-a'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(0);
    await expect(fs.stat('/workspace/skills/skill-alpha')).resolves.toBeDefined();
    await expect(fs.stat('/workspace/skills/skill-beta')).resolves.toBeDefined();
    await expect(fs.stat('/workspace/skills/skill-gamma')).rejects.toThrow();
  });

  it('--all installs skills from all local-source plugins and warns about git-subdir', async () => {
    const zipBytes = makeMarketplaceZip({
      plugins: [
        { name: 'tool-set-a', source: './plugins/tool-set-a', skills: ['skill-alpha'] },
        { name: 'tool-set-b', source: './plugins/tool-set-b', skills: ['skill-beta'] },
        {
          name: 'external',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/org/repo',
            path: '.',
            sha: 'abc',
          },
        },
      ],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['owner/repo', '--all'], createMockCtx() as any);

    expect(result.exitCode).toBe(1); // non-zero because git-subdir produces stderr
    await expect(fs.stat('/workspace/skills/skill-alpha')).resolves.toBeDefined();
    await expect(fs.stat('/workspace/skills/skill-beta')).resolves.toBeDefined();
    expect(result.stderr).toContain('external');
    expect(result.stderr).toContain('git-subdir');
  });

  it('--plugin and --skill together return a mutual exclusion error', async () => {
    const zipBytes = makeMarketplaceZip({
      plugins: [{ name: 'tool-set-a', source: './plugins/tool-set-a', skills: ['skill-alpha'] }],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['owner/repo', '--plugin', 'tool-set-a', '--skill', 'skill-alpha'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('unknown --plugin name returns a clear error', async () => {
    const zipBytes = makeMarketplaceZip({
      plugins: [{ name: 'tool-set-a', source: './plugins/tool-set-a', skills: ['skill-alpha'] }],
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(
      ['owner/repo', '--plugin', 'does-not-exist'],
      createMockCtx() as any
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"does-not-exist"');
    expect(result.stderr).toContain('not found');
  });

  it('repos without a manifest fall back to existing flat listing', async () => {
    const encoder = new TextEncoder();
    const zipBytes = zipSync({
      'repo-main/plain-skill/SKILL.md': encoder.encode('---\nname: plain-skill\n---\n# Plain\n'),
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('codeload.github.com')) return response(200, zipBytes);
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['owner/repo'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('plain-skill');
    expect(result.stdout).not.toContain('marketplace');
    expect(result.stdout).toContain('upskill owner/repo --skill');
  });
});
