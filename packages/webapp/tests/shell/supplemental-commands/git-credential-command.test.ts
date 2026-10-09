import { describe, expect, it, vi } from 'vitest';
import {
  createGitCredentialCommand,
  type GitCredentialDeps,
} from '../../../src/shell/supplemental-commands/git-credential-command.js';
import type {
  MaskedRecord,
  SecretBackend,
} from '../../../src/shell/supplemental-commands/secret-backends.js';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const OAUTH_MASK = 'gho_maskedOAUTHmaskedOAUTHmaskedOAUTH0000';

/** A store holding `records` (masked values and scopes). */
function store(records: MaskedRecord[]): SecretBackend {
  const byName = new Map(records.map((r) => [r.name, r]));
  return {
    list: vi.fn(async () => ({
      entries: records.map(({ name, domains }) => ({ name, domains, persisted: false })),
      warnings: [],
    })),
    getInfo: vi.fn(async () => null),
    getMasked: vi.fn(async (name: string) => byName.get(name) ?? null),
    peek: vi.fn(async () => null),
    setSession: vi.fn(async () => {}),
    setPersisted: vi.fn(async () => {}),
    setScope: vi.fn(async () => {}),
    delete: vi.fn(async () => ({ removed: false })),
  };
}

function request(fields: Record<string, string>): string {
  return `${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n\n`;
}

async function helper(
  op: string,
  fields: Record<string, string>,
  deps: GitCredentialDeps,
  env: Record<string, string> = {}
) {
  const ctx = mockCommandContext({ stdin: request(fields), env: new Map(Object.entries(env)) });
  const backend = store([]);
  return createGitCredentialCommand({ backend: () => backend, ...deps }).execute([op], ctx);
}

/** SLICC's own `git` token chain, as `GitCommands.githubCredential` resolves it. */
function githubChain(file?: string) {
  return vi.fn(
    async (env: Readonly<Record<string, string>>, _opts?: { force?: boolean }) =>
      file ?? (env.GH_TOKEN || env.GITHUB_TOKEN || undefined)
  );
}

describe('git-credential-slicc get', () => {
  it.each(['github.com', 'api.github.com'])(
    'uses the default GitHub scope for %s without a domain callback',
    async (host) => {
      const r = await helper(
        'get',
        { protocol: 'https', host },
        { githubToken: githubChain(OAUTH_MASK) }
      );
      expect(r.stdout).toBe(`username=x-access-token\npassword=${OAUTH_MASK}\n`);
    }
  );

  it('answers a GitHub host with the OAuth mask SLICC git uses, freshened first', async () => {
    const githubToken = githubChain(OAUTH_MASK);
    const r = await helper(
      'get',
      { protocol: 'https', host: 'github.com', path: 'o/r.git' },
      { githubToken, backend: () => store([]) }
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`username=x-access-token\npassword=${OAUTH_MASK}\n`);
    expect(githubToken).toHaveBeenCalledWith(expect.any(Object));
  });

  it('keeps the username the URL names', async () => {
    const r = await helper(
      'get',
      { protocol: 'https', host: 'github.com', username: 'octocat' },
      { githubToken: githubChain(OAUTH_MASK) }
    );
    expect(r.stdout).toBe(`username=octocat\npassword=${OAUTH_MASK}\n`);
  });

  it('covers the OAuth token domains, a port notwithstanding', async () => {
    const deps = { githubToken: githubChain(OAUTH_MASK), githubDomains: () => ['ghe.corp'] };
    const r = await helper('get', { protocol: 'https', host: 'ghe.corp:8443' }, deps);
    expect(r.stdout).toContain(`password=${OAUTH_MASK}`);
    const gh = await helper('get', { protocol: 'https', host: 'github.com' }, deps);
    expect(gh.stdout).toBe('');
  });

  it.each([
    ['a host outside its domains', { protocol: 'https', host: 'evil.example' }],
    ['a look-alike host', { protocol: 'https', host: 'github.com.evil.example' }],
    ['plain http', { protocol: 'http', host: 'github.com' }],
    ['a request with no host', { protocol: 'https' }],
  ])('offers nothing to %s', async (_label, fields) => {
    const r = await helper('get', fields, {
      githubToken: githubChain(OAUTH_MASK),
      backend: () => store([]),
    });
    expect(r).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('scopes an env token by its secret: GITHUB_TOKEN for api.github.com only stays there', async () => {
    const mask = 'ghp_maskedENVmaskedENVmaskedENVmasked000';
    const deps = {
      githubToken: githubChain(),
      backend: () =>
        store([{ name: 'GITHUB_TOKEN', maskedValue: mask, domains: ['api.github.com'] }]),
    };
    const env = { GITHUB_TOKEN: mask };
    expect((await helper('get', { protocol: 'https', host: 'github.com' }, deps, env)).stdout).toBe(
      ''
    );
    expect(
      (await helper('get', { protocol: 'https', host: 'api.github.com' }, deps, env)).stdout
    ).toContain(`password=${mask}`);
  });

  it('confines an env token that is no secret to GitHub', async () => {
    const deps = { githubToken: githubChain(), backend: () => store([]) };
    const env = { GH_TOKEN: 'plain-value' };
    const gh = await helper('get', { protocol: 'https', host: 'github.com' }, deps, env);
    expect(gh.stdout).toContain('password=plain-value');
    const other = await helper('get', { protocol: 'https', host: 'gitlab.com' }, deps, env);
    expect(other.stdout).toBe('');
  });

  it('answers another host with a token secret scoped to it, exact before wildcard', async () => {
    const backend = store([
      { name: 'A_WILD_TOKEN', maskedValue: 'mask-wild', domains: ['*.gitlab.com'] },
      { name: 'GITLAB_PAT', maskedValue: 'mask-exact', domains: ['gitlab.com', '*.gitlab.com'] },
      { name: 'OPENAI_KEY', maskedValue: 'mask-key', domains: ['gitlab.com'] },
      { name: 'ANY_TOKEN', maskedValue: 'mask-any', domains: ['*'] },
    ]);
    const deps = { githubToken: githubChain(OAUTH_MASK), backend: () => backend };
    const exact = await helper('get', { protocol: 'https', host: 'gitlab.com' }, deps);
    expect(exact.stdout).toBe('username=x-access-token\npassword=mask-exact\n');
    const sub = await helper('get', { protocol: 'https', host: 'code.gitlab.com' }, deps);
    expect(sub.stdout).toContain('password=mask-wild');
    // A `*` scope is nobody's: ANY_TOKEN never goes to a host that just asks.
    const none = await helper('get', { protocol: 'https', host: 'evil.example' }, deps);
    expect(none.stdout).toBe('');
  });

  it('answers nothing, not an error, when SLICC holds no credential or the store fails', async () => {
    const failing = store([]);
    failing.list = vi.fn(async () => {
      throw new Error('bridge down');
    });
    const r = await helper(
      'get',
      { protocol: 'https', host: 'github.com' },
      { githubToken: vi.fn(async () => undefined), backend: () => failing }
    );
    expect(r).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });
});

describe('git-credential-slicc store / erase', () => {
  it('store keeps nothing', async () => {
    const githubToken = githubChain(OAUTH_MASK);
    const r = await helper(
      'store',
      { protocol: 'https', host: 'github.com', password: OAUTH_MASK },
      { githubToken }
    );
    expect(r).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(githubToken).not.toHaveBeenCalled();
  });

  it('erase of the rejected GitHub token renews it', async () => {
    const githubToken = githubChain(OAUTH_MASK);
    await helper(
      'erase',
      { protocol: 'https', host: 'github.com', password: OAUTH_MASK },
      { githubToken }
    );
    expect(githubToken).toHaveBeenCalledWith(expect.any(Object), { force: true });
  });

  it('erase of some other credential renews nothing', async () => {
    const githubToken = githubChain(OAUTH_MASK);
    await helper(
      'erase',
      { protocol: 'https', host: 'gitlab.com', password: 'mask-exact' },
      { githubToken }
    );
    expect(githubToken).not.toHaveBeenCalledWith(expect.any(Object), { force: true });
  });
});

describe('git-credential-slicc usage', () => {
  it('is a shell command, so native git (in the realm) can run it', () => {
    expect(createSupplementalCommands().map((c) => c.name)).toContain('git-credential-slicc');
  });

  it('prints usage for --help and fails without an operation', async () => {
    const cmd = createGitCredentialCommand();
    const help = await cmd.execute(['--help'], mockCommandContext());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('usage: git-credential-slicc');
    expect((await cmd.execute([], mockCommandContext())).exitCode).toBe(1);
  });
});
