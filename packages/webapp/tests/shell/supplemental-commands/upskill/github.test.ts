import 'fake-indexeddb/auto';

import type { SecureFetch } from 'just-bash';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import {
  _resetGlobalFsCache,
  createUpskillCommand,
  parseGitHubRef,
} from '../../../../src/shell/supplemental-commands/upskill/index.js';
import { createMockCtx, response } from './test-helpers.js';

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
