import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretBackend } from '../../../src/shell/supplemental-commands/secret-backends.js';
import {
  createSecretCommand,
  type SecretCommandDeps,
} from '../../../src/shell/supplemental-commands/secret-command.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';

function ctx(stdin = '') {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return { fs: fs as IFileSystem, cwd: '/home', env: new Map<string, string>(), stdin };
}

function makeBackend(overrides: Partial<SecretBackend> = {}): SecretBackend {
  return {
    list: vi.fn(async () => []),
    getInfo: vi.fn(async () => null),
    getMasked: vi.fn(async () => null),
    peek: vi.fn(async () => null),
    setSession: vi.fn(async () => {}),
    setPersisted: vi.fn(async () => {}),
    setScope: vi.fn(async () => {}),
    delete: vi.fn(async () => ({ removed: false })),
    ...overrides,
  };
}

function makeBroker(decision: SudoDecision): { broker: SudoBroker; calls: () => number } {
  const fn = vi.fn(async () => decision);
  return { broker: { requestApproval: fn }, calls: () => fn.mock.calls.length };
}

function run(args: string[], deps: SecretCommandDeps, stdin = '') {
  return createSecretCommand({ isExtension: false, grants: new Set(), ...deps }).execute(
    args,
    ctx(stdin)
  );
}

describe('secret command — session ops (no approval)', () => {
  let broker: ReturnType<typeof makeBroker>;
  beforeEach(() => {
    broker = makeBroker({ decision: 'deny' });
  });

  it('set of a new session secret never prompts', async () => {
    const backend = makeBackend();
    const res = await run(['set', 'OPENAI_KEY', 'sk-1234', '--domain', 'api.openai.com'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(0);
    expect(broker.calls()).toBe(0);
    expect(backend.setSession).toHaveBeenCalledWith('OPENAI_KEY', 'sk-1234', ['api.openai.com']);
    expect(backend.setPersisted).not.toHaveBeenCalled();
    expect(res.stdout).toContain('not persisted');
  });

  it('get returns the masked value + scope without prompting', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => ({
        name: 'OPENAI_KEY',
        maskedValue: 'sk-deadbeef',
        domains: ['api.openai.com'],
      })),
    });
    const res = await run(['get', 'OPENAI_KEY'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(0);
    expect(broker.calls()).toBe(0);
    expect(res.stdout).toContain('OPENAI_KEY=sk-deadbeef');
    expect(res.stdout).toContain('api.openai.com');
  });

  it('peek returns the elided preview without prompting', async () => {
    const backend = makeBackend({
      peek: vi.fn(async () => ({ name: 'OPENAI_KEY', preview: 'sk-1…3456', domains: ['x'] })),
    });
    const res = await run(['peek', 'OPENAI_KEY'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(0);
    expect(broker.calls()).toBe(0);
    expect(res.stdout).toContain('sk-1…3456');
  });
});

describe('secret command — gated ops', () => {
  it('persisted set prompts and blocks on deny', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'deny' });
    const res = await run(['set', 'TOKEN', 'v', '--domain', 'api.x.com', '--persist'], {
      backend,
      broker: broker.broker,
    });
    expect(broker.calls()).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('approval denied');
    expect(backend.setPersisted).not.toHaveBeenCalled();
  });

  it('persisted set proceeds on allow', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'allow' });
    const res = await run(['set', 'TOKEN', 'v', '--domain', 'api.x.com', '--persist'], {
      backend,
      broker: broker.broker,
    });
    expect(broker.calls()).toBe(1);
    expect(res.exitCode).toBe(0);
    expect(backend.setPersisted).toHaveBeenCalledWith('TOKEN', 'v', ['api.x.com']);
  });

  it('scope edit prompts and blocks on deny', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'deny' });
    const res = await run(['scope', 'TOKEN', '--domain', 'api.x.com'], {
      backend,
      broker: broker.broker,
    });
    expect(broker.calls()).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(backend.setScope).not.toHaveBeenCalled();
  });

  it('value change of an existing secret prompts and blocks on deny', async () => {
    const backend = makeBackend({
      getInfo: vi.fn(async () => ({ name: 'TOKEN', domains: ['x'], persisted: false })),
    });
    const broker = makeBroker({ decision: 'deny' });
    const res = await run(['set', 'TOKEN', 'newval'], { backend, broker: broker.broker });
    expect(broker.calls()).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(backend.setSession).not.toHaveBeenCalled();
  });

  it('"Always" grant skips the prompt on the next identical op', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'always', pattern: 'secret:scope:TOKEN' });
    const grants = new Set<string>();
    const deps = { backend, broker: broker.broker, grants, isExtension: false };
    await createSecretCommand(deps).execute(['scope', 'TOKEN', '--domain', 'a.com'], ctx());
    await createSecretCommand(deps).execute(['scope', 'TOKEN', '--domain', 'b.com'], ctx());
    expect(broker.calls()).toBe(1);
    expect(backend.setScope).toHaveBeenCalledTimes(2);
  });

  it('"Always" with an edited wildcard pattern covers later matching ops', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'always', pattern: 'secret:scope:*' });
    const grants = new Set<string>();
    const deps = { backend, broker: broker.broker, grants, isExtension: false };
    await createSecretCommand(deps).execute(['scope', 'TOKEN', '--domain', 'a.com'], ctx());
    await createSecretCommand(deps).execute(['scope', 'OTHER', '--domain', 'b.com'], ctx());
    expect(broker.calls()).toBe(1);
    expect(backend.setScope).toHaveBeenCalledTimes(2);
  });

  it('"Always" with a never-match pattern falls back to the exact subject', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'always', pattern: 'totally:unrelated' });
    const grants = new Set<string>();
    const deps = { backend, broker: broker.broker, grants, isExtension: false };
    await createSecretCommand(deps).execute(['scope', 'TOKEN', '--domain', 'a.com'], ctx());
    await createSecretCommand(deps).execute(['scope', 'TOKEN', '--domain', 'b.com'], ctx());
    expect(broker.calls()).toBe(1);
    expect(grants.has('secret:scope:TOKEN')).toBe(true);
    expect(grants.has('totally:unrelated')).toBe(false);
  });
});

describe('secret command — stdin value', () => {
  let broker: ReturnType<typeof makeBroker>;
  beforeEach(() => {
    broker = makeBroker({ decision: 'deny' });
  });

  it('reads the value from stdin when no arg is given', async () => {
    const backend = makeBackend();
    const res = await run(
      ['set', 'OPENAI_KEY', '--domain', 'api.openai.com'],
      { backend, broker: broker.broker },
      'sk-from-stdin\n'
    );
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalledWith('OPENAI_KEY', 'sk-from-stdin', [
      'api.openai.com',
    ]);
  });

  it('trims a single trailing \\n from stdin (echo pattern)', async () => {
    const backend = makeBackend();
    await run(['set', 'K'], { backend, broker: broker.broker }, 'value\n');
    expect(backend.setSession).toHaveBeenCalledWith('K', 'value', []);
  });

  it('trims a single trailing \\r\\n from stdin', async () => {
    const backend = makeBackend();
    await run(['set', 'K'], { backend, broker: broker.broker }, 'value\r\n');
    expect(backend.setSession).toHaveBeenCalledWith('K', 'value', []);
  });

  it('does not trim when stdin has no trailing newline (printf %s pattern)', async () => {
    const backend = makeBackend();
    await run(['set', 'K'], { backend, broker: broker.broker }, 'value');
    expect(backend.setSession).toHaveBeenCalledWith('K', 'value', []);
  });

  it('preserves embedded newlines, only trimming the final one', async () => {
    const backend = makeBackend();
    await run(['set', 'K'], { backend, broker: broker.broker }, 'line1\nline2\n');
    expect(backend.setSession).toHaveBeenCalledWith('K', 'line1\nline2', []);
  });

  it('errors when both arg and stdin are provided', async () => {
    const backend = makeBackend();
    const res = await run(
      ['set', 'K', 'arg-value'],
      { backend, broker: broker.broker },
      'stdin-value\n'
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('argument OR via stdin');
    expect(backend.setSession).not.toHaveBeenCalled();
    expect(backend.setPersisted).not.toHaveBeenCalled();
  });

  it('errors when no value is provided (no arg, empty stdin)', async () => {
    const backend = makeBackend();
    const res = await run(['set', 'K'], { backend, broker: broker.broker }, '');
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('requires a <value>');
    expect(backend.setSession).not.toHaveBeenCalled();
  });

  it('reads stdin value for a --persist set (with --domain)', async () => {
    const backend = makeBackend();
    const allowBroker = makeBroker({ decision: 'allow' });
    const res = await run(
      ['set', 'TOKEN', '--domain', 'api.x.com', '--persist'],
      { backend, broker: allowBroker.broker },
      'pv\n'
    );
    expect(res.exitCode).toBe(0);
    expect(backend.setPersisted).toHaveBeenCalledWith('TOKEN', 'pv', ['api.x.com']);
  });
});

describe('secret command — masked-env injection on set', () => {
  let broker: ReturnType<typeof makeBroker>;
  beforeEach(() => {
    broker = makeBroker({ decision: 'allow' });
  });

  it('injects the masked value into the shell env after session set', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => ({
        name: 'OPENAI_KEY',
        maskedValue: 'sk-masked-xyz',
        domains: ['api.openai.com'],
      })),
    });
    const setEnv = vi.fn();
    const res = await run(['set', 'OPENAI_KEY', 'sk-real', '--domain', 'api.openai.com'], {
      backend,
      broker: broker.broker,
      setEnv,
    });
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalledWith('OPENAI_KEY', 'sk-real', ['api.openai.com']);
    expect(backend.getMasked).toHaveBeenCalledWith('OPENAI_KEY');
    expect(setEnv).toHaveBeenCalledWith('OPENAI_KEY', 'sk-masked-xyz');
  });

  it('injects the masked value into the shell env after persisted set', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => ({
        name: 'TOKEN',
        maskedValue: 'masked-persist',
        domains: ['api.x.com'],
      })),
    });
    const setEnv = vi.fn();
    const res = await run(['set', 'TOKEN', 'pv', '--domain', 'api.x.com', '--persist'], {
      backend,
      broker: broker.broker,
      setEnv,
    });
    expect(res.exitCode).toBe(0);
    expect(setEnv).toHaveBeenCalledWith('TOKEN', 'masked-persist');
  });

  it('skips env injection for non-POSIX dot-namespaced names', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => ({
        name: 's3.r2.access_key_id',
        maskedValue: 'AKIAmasked',
        domains: ['*.r2.com'],
      })),
    });
    const setEnv = vi.fn();
    const res = await run(['set', 's3.r2.access_key_id', 'AKIAreal', '--domain', '*.r2.com'], {
      backend,
      broker: broker.broker,
      setEnv,
    });
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalled();
    // POSIX filter rejects dotted names — setEnv MUST NOT be called.
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('skips env injection when getMasked returns null (no throw)', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => null),
    });
    const setEnv = vi.fn();
    const res = await run(['set', 'OPENAI_KEY', 'sk-real', '--domain', 'api.openai.com'], {
      backend,
      broker: broker.broker,
      setEnv,
    });
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalled();
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('does not call setEnv when no hook is supplied (backward compatible)', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => ({
        name: 'OPENAI_KEY',
        maskedValue: 'sk-masked-xyz',
        domains: ['api.openai.com'],
      })),
    });
    const res = await run(['set', 'OPENAI_KEY', 'sk-real', '--domain', 'api.openai.com'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalled();
  });

  it('does not fail the set when getMasked itself rejects', async () => {
    const backend = makeBackend({
      getMasked: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const setEnv = vi.fn();
    const res = await run(['set', 'OPENAI_KEY', 'sk-real', '--domain', 'api.openai.com'], {
      backend,
      broker: broker.broker,
      setEnv,
    });
    expect(res.exitCode).toBe(0);
    expect(setEnv).not.toHaveBeenCalled();
  });
});

describe('secret command — delete / rm', () => {
  let broker: ReturnType<typeof makeBroker>;
  beforeEach(() => {
    broker = makeBroker({ decision: 'deny' });
  });

  it('delete removes a persisted secret and reports the scope', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: false })),
    });
    const res = await run(['delete', 'GITHUB_TOKEN'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(0);
    expect(backend.delete).toHaveBeenCalledWith('GITHUB_TOKEN');
    expect(res.stdout).toContain('Removed persisted secret "GITHUB_TOKEN"');
    expect(res.stderr).toBe('');
    // No prompt — agent self-cleanup should not require sudo approval.
    expect(broker.calls()).toBe(0);
  });

  it('rm is an alias of delete', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: true })),
    });
    const res = await run(['rm', 'SESSION_KEY'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(0);
    expect(backend.delete).toHaveBeenCalledWith('SESSION_KEY');
    expect(res.stdout).toContain('Removed session secret "SESSION_KEY"');
  });

  it('reports a clean not-found error when the secret does not exist', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: false })),
    });
    const res = await run(['delete', 'GHOST'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('no secret named "GHOST"');
    expect(res.stdout).toBe('');
  });

  it('requires a <name> argument', async () => {
    const backend = makeBackend();
    const res = await run(['delete'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('delete requires a <name>');
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it('rm also requires a <name> argument', async () => {
    const backend = makeBackend();
    const res = await run(['rm'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('rm requires a <name>');
  });

  it('surfaces backend errors via stderr without crashing', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const res = await run(['delete', 'KEY'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('network down');
  });

  it('never echoes the secret value', async () => {
    // Defense-in-depth: even if a misbehaving backend leaked a value, the
    // command must not echo it back. The mock returns only `removed`/
    // `fromSession`, so the produced output should not contain anything
    // resembling a token.
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: false })),
    });
    const res = await run(['delete', 'GITHUB_TOKEN'], { backend, broker: broker.broker });
    expect(res.stdout).not.toMatch(/ghp_|sk-|=/);
  });
});
