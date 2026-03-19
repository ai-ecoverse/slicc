import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem, SecureFetch } from 'just-bash';
import { VirtualFS } from '../../fs/index.js';
import { createUpskillCommand, _resetGlobalFsCache } from './upskill-command.js';

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

function response(status: number, body: string, headers: Record<string, string> = {}, statusText = '') {
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
      createdFileSystems.map((instance) => (instance.getLightningFS() as { _deactivate?: () => Promise<void> })._deactivate?.()),
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
      if (url.endsWith('/contents/')) {
        return response(200, JSON.stringify([{ name: 'alpha', path: 'alpha', type: 'dir' }]));
      }
      if (url.endsWith('/contents/alpha')) {
        return response(200, JSON.stringify([
          { name: 'SKILL.md', path: 'alpha/SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/SKILL.md' },
          { name: 'helper.txt', path: 'alpha/helper.txt', type: 'file', download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/helper.txt' },
        ]));
      }
      if (url.endsWith('/alpha/SKILL.md')) return response(200, '# Alpha skill\n');
      if (url.endsWith('/alpha/helper.txt')) return response(200, 'helper\n');
      throw new Error(`unexpected url: ${url}`);
    });

    const cmd = createUpskillCommand(fs, fetchMock as unknown as SecureFetch);
    const result = await cmd.execute(['octo/skills', '--all'], createMockCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Installed skill "alpha" from octo/skills');
    await expect(fs.readTextFile('/workspace/skills/alpha/SKILL.md')).resolves.toContain('Alpha skill');

    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toContain('github');
      expect(options?.headers?.Authorization).toBe('Bearer ghp_test_token');
    }
  });

  it('classifies anonymous GitHub rate-limit failures when listing skills', async () => {
    const fetchMock = vi.fn(async (_url: string, options?: { headers?: Record<string, string> }) => {
      expect(options?.headers?.Authorization).toBeUndefined();
      return response(
        403,
        JSON.stringify({ message: 'API rate limit exceeded for 198.51.100.10.' }),
        { 'x-ratelimit-remaining': '0' },
        'Forbidden',
      );
    });

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
      if (url.endsWith('/contents/')) {
        return response(200, JSON.stringify([{ name: 'alpha', path: 'alpha', type: 'dir' }]));
      }
      if (url.endsWith('/contents/alpha')) {
        alphaRequests += 1;
        if (alphaRequests === 1) {
          return response(200, JSON.stringify([
            { name: 'SKILL.md', path: 'alpha/SKILL.md', type: 'file', download_url: 'https://raw.githubusercontent.com/octo/skills/main/alpha/SKILL.md' },
          ]));
        }
        return response(
          429,
          JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }),
          { 'retry-after': '60' },
          'Too Many Requests',
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