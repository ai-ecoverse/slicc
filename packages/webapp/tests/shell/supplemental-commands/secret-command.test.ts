import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretBackend } from '../../../src/shell/supplemental-commands/secret-backends.js';
import {
  createSecretCommand,
  type SecretCommandDeps,
} from '../../../src/shell/supplemental-commands/secret-command.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';

function ctx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return { fs: fs as IFileSystem, cwd: '/home', env: new Map<string, string>(), stdin: '' };
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
    ...overrides,
  };
}

function makeBroker(decision: SudoDecision): { broker: SudoBroker; calls: () => number } {
  const fn = vi.fn(async () => decision);
  return { broker: { requestApproval: fn }, calls: () => fn.mock.calls.length };
}

function run(args: string[], deps: SecretCommandDeps) {
  return createSecretCommand({ isExtension: false, grants: new Set(), ...deps }).execute(
    args,
    ctx()
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
