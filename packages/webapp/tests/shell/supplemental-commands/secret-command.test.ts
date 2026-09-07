import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretBackend } from '../../../src/shell/supplemental-commands/secret-backends.js';
import {
  createSecretCommand,
  type SecretCommandDeps,
} from '../../../src/shell/supplemental-commands/secret-command.js';
import type { SudoBroker, SudoDecision } from '../../../src/sudo/types.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const ctx = (stdin = '') => mockCommandContext({ stdin });

function makeBackend(overrides: Partial<SecretBackend> = {}): SecretBackend {
  return {
    list: vi.fn(async () => ({ entries: [], warnings: [] })),
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

describe('secret command — domain validation', () => {
  it.each([
    ['session argument without --domain', ['set', 'TOKEN', 'value'], ''],
    ['session argument with an empty --domain', ['set', 'TOKEN', 'value', '--domain', ''], ''],
    ['session stdin without --domain', ['set', 'TOKEN'], 'value\n'],
    [
      'persisted argument with no --domain value',
      ['set', 'TOKEN', 'value', '--domain', '--persist'],
      '',
    ],
    [
      'persisted argument with a comma-only --domain',
      ['set', 'TOKEN', 'value', '--domain', ' , ', '--persist'],
      '',
    ],
  ])('rejects %s before lookup, approval, or mutation', async (_label, args, stdin) => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'allow' });
    const res = await run(args, { backend, broker: broker.broker }, stdin);

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('set requires --domain <patterns>');
    expect(backend.getInfo).not.toHaveBeenCalled();
    expect(backend.setSession).not.toHaveBeenCalled();
    expect(backend.setPersisted).not.toHaveBeenCalled();
    expect(backend.getMasked).not.toHaveBeenCalled();
    expect(broker.calls()).toBe(0);
  });

  it('documents --domain as required in command help', async () => {
    const res = await run(['--help'], { backend: makeBackend() });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('secret set <name> <value> --domain <pat>');
    expect(res.stdout).toContain('required --domain flag');
  });
});

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

  it('accepts exact and wildcard domains', async () => {
    const backend = makeBackend();
    const res = await run(['set', 'TOKEN', 'value', '--domain', 'api.x.com,*.x.com'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalledWith('TOKEN', 'value', ['api.x.com', '*.x.com']);
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

  it('persisted set reports a timeout as unanswered, not denied', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'deny', reason: 'user-timeout' });
    const res = await run(['set', 'TOKEN', 'v', '--domain', 'api.x.com', '--persist'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('timed out');
    expect(res.stderr).not.toContain('approval denied');
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
    const res = await run(['set', 'TOKEN', 'newval', '--domain', 'api.x.com'], {
      backend,
      broker: broker.broker,
    });
    expect(broker.calls()).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(backend.setSession).not.toHaveBeenCalled();
  });
});

// #2276 round-1 review finding 4: `deps.broker` omitted entirely (no
// SudoManager was wired for this shell — an ungated ad-hoc shell, not the
// panel terminal or a normal cone/scoop, both of which DO wire a real
// broker) falls back to `createSudoBroker(null)`, which fails closed. Every
// gated op must deny with the SAME "approval denied" message a real broker's
// `deny` produces — not throw, not silently proceed.
describe('secret command — no broker injected (unwired shell) fails every gate closed', () => {
  it('persisted set denies with "approval denied" and never persists', async () => {
    const backend = makeBackend();
    const res = await run(['set', 'TOKEN', 'v', '--domain', 'api.x.com', '--persist'], {
      backend,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('approval denied');
    expect(backend.setPersisted).not.toHaveBeenCalled();
  });

  it('scope edit denies with "approval denied" and never rescopes', async () => {
    const backend = makeBackend();
    const res = await run(['scope', 'TOKEN', '--domain', 'api.x.com'], { backend });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('approval denied');
    expect(backend.setScope).not.toHaveBeenCalled();
  });

  it('value change of an existing secret denies with "approval denied" and never overwrites', async () => {
    const backend = makeBackend({
      getInfo: vi.fn(async () => ({ name: 'TOKEN', domains: ['x'], persisted: false })),
    });
    const res = await run(['set', 'TOKEN', 'newval', '--domain', 'api.x.com'], { backend });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('approval denied');
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
    await run(['set', 'K', '--domain', 'api.x.com'], { backend, broker: broker.broker }, 'value\n');
    expect(backend.setSession).toHaveBeenCalledWith('K', 'value', ['api.x.com']);
  });

  it('trims a single trailing \\r\\n from stdin', async () => {
    const backend = makeBackend();
    await run(
      ['set', 'K', '--domain', 'api.x.com'],
      { backend, broker: broker.broker },
      'value\r\n'
    );
    expect(backend.setSession).toHaveBeenCalledWith('K', 'value', ['api.x.com']);
  });

  it('does not trim when stdin has no trailing newline (printf %s pattern)', async () => {
    const backend = makeBackend();
    await run(['set', 'K', '--domain', 'api.x.com'], { backend, broker: broker.broker }, 'value');
    expect(backend.setSession).toHaveBeenCalledWith('K', 'value', ['api.x.com']);
  });

  it('preserves embedded newlines, only trimming the final one', async () => {
    const backend = makeBackend();
    await run(
      ['set', 'K', '--domain', 'api.x.com'],
      { backend, broker: broker.broker },
      'line1\nline2\n'
    );
    expect(backend.setSession).toHaveBeenCalledWith('K', 'line1\nline2', ['api.x.com']);
  });

  it('errors when both arg and stdin are provided', async () => {
    const backend = makeBackend();
    const res = await run(
      ['set', 'K', 'arg-value', '--domain', 'api.x.com'],
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
    const res = await run(
      ['set', 'K', '--domain', 'api.x.com'],
      { backend, broker: broker.broker },
      ''
    );
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

  // A mask that outlives its secret is worse than a missing var: `$NAME` still
  // expands, so the request is built and sent, and the fetch proxy has no
  // secret left to match — it neither unmasks nor 403s. Upstream just receives
  // a dead credential. Observed live on both privileged bridges.
  it('clears the masked shell env var after a successful delete', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: true })),
    });
    const unsetEnv = vi.fn();
    const res = await run(['delete', 'OPENAI_KEY'], {
      backend,
      broker: broker.broker,
      unsetEnv,
    });
    expect(res.exitCode).toBe(0);
    expect(unsetEnv).toHaveBeenCalledWith('OPENAI_KEY');
  });

  it('clears the masked shell env var after deleting a persisted secret too', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: false })),
    });
    const unsetEnv = vi.fn();
    const res = await run(['rm', 'TOKEN'], { backend, broker: broker.broker, unsetEnv });
    expect(res.exitCode).toBe(0);
    expect(unsetEnv).toHaveBeenCalledWith('TOKEN');
  });

  it('leaves the env alone when the secret did not exist', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: false })),
    });
    const unsetEnv = vi.fn();
    const res = await run(['delete', 'NOPE'], { backend, broker: broker.broker, unsetEnv });
    expect(res.exitCode).toBe(1);
    expect(unsetEnv).not.toHaveBeenCalled();
  });

  it('skips the env clear for non-POSIX dot-namespaced names', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: true })),
    });
    const unsetEnv = vi.fn();
    const res = await run(['delete', 's3.r2.access_key_id'], {
      backend,
      broker: broker.broker,
      unsetEnv,
    });
    expect(res.exitCode).toBe(0);
    // Never injected (same POSIX filter as `secret set`), so nothing to clear.
    expect(unsetEnv).not.toHaveBeenCalled();
  });

  it('deletes fine when no unsetEnv hook is supplied (backward compatible)', async () => {
    const backend = makeBackend({
      delete: vi.fn(async () => ({ removed: true, fromSession: true })),
    });
    const res = await run(['delete', 'OPENAI_KEY'], { backend, broker: broker.broker });
    expect(res.exitCode).toBe(0);
    expect(backend.delete).toHaveBeenCalledWith('OPENAI_KEY');
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

describe('secret command — unknown flags (#2255)', () => {
  it('rejects an unknown flag with a non-zero exit instead of swallowing it', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'allow' });
    const res = await run(['set', 'TOKEN', 'value', '--domain', 'api.x.com', '--totally-fake'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown flag: --totally-fake');
    expect(backend.setSession).not.toHaveBeenCalled();
    expect(broker.calls()).toBe(0);
  });

  it('rejects unknown flags on verbs that take no flags', async () => {
    const backend = makeBackend({
      list: vi.fn(async () => ({
        entries: [{ name: 'K', domains: ['x'], persisted: false }],
        warnings: [],
      })),
    });
    const res = await run(['list', '--json'], { backend });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown flag: --json');
    expect(backend.list).not.toHaveBeenCalled();
  });

  it('accepts --domain / --persist in any position', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'deny' });
    const res = await run(['set', '--persist', '--domain', 'api.x.com', 'TOKEN', 'value'], {
      backend,
      broker: broker.broker,
    });
    // --persist gates; deny blocks before mutation.
    expect(broker.calls()).toBe(1);
    expect(res.exitCode).toBe(1);
    expect(backend.setPersisted).not.toHaveBeenCalled();
  });

  it('rejects --persist=false instead of treating it as --persist', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'allow' });
    const res = await run(['set', 'TOKEN', 'value', '--domain', 'api.x.com', '--persist=false'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown flag: --persist');
    expect(backend.setSession).not.toHaveBeenCalled();
    expect(backend.setPersisted).not.toHaveBeenCalled();
    expect(broker.calls()).toBe(0);
  });

  it('honours -- so a dash-prefixed value is positional', async () => {
    const backend = makeBackend();
    const broker = makeBroker({ decision: 'deny' });
    const res = await run(['set', 'TOKEN', '--domain', 'api.x.com', '--', '-sk-leading-dash'], {
      backend,
      broker: broker.broker,
    });
    expect(res.exitCode).toBe(0);
    expect(backend.setSession).toHaveBeenCalledWith('TOKEN', '-sk-leading-dash', ['api.x.com']);
  });
});

describe('secret command — list and test with an unreadable store', () => {
  const stalledSaved =
    'could not read saved secrets — no response from the secret store within 10s';

  it('lists the readable half and reports the store it could not read', async () => {
    const backend = makeBackend({
      list: vi.fn(async () => ({
        entries: [{ name: 'E2E_TOKEN', domains: ['127.0.0.1'], persisted: false }],
        warnings: [stalledSaved],
      })),
    });
    const res = await run(['list'], { backend });

    // The SESSION row still prints — a store that cannot be read must not
    // suppress the one that can.
    expect(res.stdout).toContain('E2E_TOKEN');
    expect(res.stdout).toContain('SESSION');
    expect(res.stderr).toBe(`secret: ${stalledSaved}\n`);
    // Non-zero so a script piping `secret list` cannot mistake a partial
    // answer for the whole truth.
    expect(res.exitCode).toBe(1);
  });

  it('never reports "No secrets stored" when a store was unreadable', async () => {
    const backend = makeBackend({
      list: vi.fn(async () => ({ entries: [], warnings: [stalledSaved] })),
    });
    const res = await run(['list'], { backend });

    expect(res.stdout).toBe('');
    expect(res.stdout).not.toContain('No secrets stored');
    expect(res.stderr).toContain(stalledSaved);
    expect(res.exitCode).toBe(1);
  });

  it('still reports an empty store as empty', async () => {
    const backend = makeBackend({
      list: vi.fn(async () => ({ entries: [], warnings: [] })),
    });
    const res = await run(['list'], { backend });

    expect(res.stdout).toBe('No secrets stored\n');
    expect(res.stderr).toBe('');
    expect(res.exitCode).toBe(0);
  });

  it('blames the unreadable store rather than claiming the secret is missing', async () => {
    const backend = makeBackend({
      list: vi.fn(async () => ({ entries: [], warnings: [stalledSaved] })),
    });
    const res = await run(['test', 'E2E_TOKEN', 'https://api.example.com/v1'], { backend });

    expect(res.stderr).toContain(stalledSaved);
    expect(res.stderr).not.toContain('no secret named');
    expect(res.exitCode).toBe(1);
  });

  it('keeps the not-found message when the stores were read cleanly', async () => {
    const backend = makeBackend();
    const res = await run(['test', 'MISSING', 'https://api.example.com/v1'], { backend });

    expect(res.stderr).toContain('no secret named "MISSING"');
    expect(res.exitCode).toBe(1);
  });
});

describe('secret command — set with an unreadable store fails closed', () => {
  it('refuses the mutation instead of treating an unknown name as new', async () => {
    const unreadable =
      'could not read saved secrets — no response from the secret store within 10s';
    const backend = makeBackend({
      // What the CLI backend does when a store is lost: an unresolvable lookup
      // raises rather than answering "absent".
      getInfo: vi.fn(async () => {
        throw new Error(unreadable);
      }),
    });
    const broker = makeBroker({ decision: 'allow' });
    const res = await run(['set', 'TOKEN', 'value', '--domain', 'api.x.com'], {
      backend,
      broker: broker.broker,
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(unreadable);
    // The gate exists to stop an agent overwriting a real credential; with the
    // store unread we cannot know whether this name holds one.
    expect(backend.setSession).not.toHaveBeenCalled();
    expect(broker.calls()).toBe(0);
  });
});
