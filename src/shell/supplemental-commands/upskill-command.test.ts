import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem, SecureFetch } from 'just-bash';
import { VirtualFS } from '../../fs/index.js';
import { initSkillsSystem } from '../../skills/index.js';
import { createSkillCommand, createUpskillCommand, _resetGlobalFsCache } from './upskill-command.js';

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

let dbCounter = 0;

describe('skill/upskill command compatibility discovery', () => {
  let fs: VirtualFS;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-upskill-command-${dbCounter++}`,
      wipe: true,
    });
    await initSkillsSystem(fs);
  });

  afterEach(() => {
    _resetGlobalFsCache();
  });

  it('skill help documents discoverable compatibility roots and native-only management', async () => {
    const result = await createSkillCommand(fs).execute(['--help'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('List discoverable skills and management status');
    expect(result.stdout).toContain('**/.agents/skills/*');
    expect(result.stdout).toContain('**/.claude/skills/*');
    expect(result.stdout).toContain('Only native /workspace/skills entries are install-managed');
  });

  it('skill list shows source and read-only compatibility status', async () => {
    await fs.mkdir('/workspace/skills/native-skill', { recursive: true });
    await fs.writeFile(
      '/workspace/skills/native-skill/manifest.yaml',
      'skill: native-skill\nversion: 1.2.3\ndescription: Native skill\n',
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
    expect(result.stdout).toContain('available');
    expect(result.stdout).toContain('compatibility (read-only)');
  });

  it('skill info reports source and management mode for compatibility skills', async () => {
    await fs.mkdir('/repo/.agents/skills/agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/agent-skill/SKILL.md', '# Agent Skill');

    const result = await createSkillCommand(fs).execute(['info', 'agent-skill'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Skill: agent-skill');
    expect(result.stdout).toContain('Source: .agents');
    expect(result.stdout).toContain('Source root: /repo/.agents/skills');
    expect(result.stdout).toContain('Management: compatibility-only (read-only)');
    expect(result.stdout).toContain('Instructions: /repo/.agents/skills/agent-skill/SKILL.md');
  });

  it('skill install refuses to mutate compatibility-discovered skills', async () => {
    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', '# Compat Skill');

    const result = await createSkillCommand(fs).execute(['install', 'compat-skill'], createMockCtx() as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('compatibility-only/read-only');
    expect(result.stderr).toContain('/repo/.claude/skills');
  });

  it('skill uninstall keeps the standard not-installed error for compatibility-only skills', async () => {
    await fs.mkdir('/repo/.claude/skills/compat-skill', { recursive: true });
    await fs.writeFile('/repo/.claude/skills/compat-skill/SKILL.md', '# Compat Skill');

    const result = await createSkillCommand(fs).execute(['uninstall', 'compat-skill'], createMockCtx() as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Skill "compat-skill" is not installed');
    expect(result.stderr).not.toContain('compatibility-only/read-only');
  });

  it('upskill list uses unified local discovery wording', async () => {
    await fs.mkdir('/repo/.agents/skills/local-agent-skill', { recursive: true });
    await fs.writeFile('/repo/.agents/skills/local-agent-skill/SKILL.md', '# Local Agent Skill');

    const result = await createUpskillCommand(fs, vi.fn() as never).execute(['list'], createMockCtx() as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Discoverable local skills:');
    expect(result.stdout).toContain('local-agent-skill');
    expect(result.stdout).toContain('.agents');
    expect(result.stdout).toContain('Only native /workspace/skills entries are install-managed');
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
      expect(options?.headers?.Authorization).toBe('Bearer ghp_test_token');
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
