import type { CommandContext } from 'just-bash';
import { expect, test, vi } from 'vitest';
import {
  clampSyncExecTimeout,
  dispatchSyncExec,
  isSyncExecRequest,
  normalizeSyncExecEnv,
  resolveSyncExecCwd,
  SYNC_EXEC_CHANNEL,
} from '../../../src/kernel/realm/sync-exec-dispatch.js';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
} from '../../../src/kernel/realm/sync-fs-token-registry.js';
import { SYNC_EXEC_MAX_TIMEOUT_MS } from '../../../src/kernel/realm/sync-fs-wire.js';

type ExecCall = { cmd: string; opts: Record<string, unknown> };

/** Mint a token whose `exec` records its calls and answers with a fixed result. */
function execToken(
  result: { stdout: string; stderr: string; exitCode: number } | Error,
  calls: ExecCall[] = []
): { token: string; calls: ExecCall[] } {
  const exec = (async (cmd: string, opts: Record<string, unknown>) => {
    calls.push({ cmd, opts });
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as CommandContext['exec'];
  const fs = {} as CommandContext['fs'];
  return { token: mintSyncFsToken({ fs, exec, cwd: '/workspace' }), calls };
}

test('runs a string command through ctx.exec and returns the buffered result', async () => {
  const { token, calls } = execToken({ stdout: 'hi\n', stderr: '', exitCode: 0 });
  const r = await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'echo hi' });
  expect(r.ok).toBe(true);
  if (r.ok && r.kind === 'json') {
    expect(r.json).toEqual({ stdout: 'hi\n', stderr: '', exitCode: 0 });
  }
  expect(calls[0]?.cmd).toBe('echo hi');
  expect(calls[0]?.opts.cwd).toBe('/workspace');
});

test('a non-zero exit is a SUCCESSFUL dispatch (not an errno)', async () => {
  // spawnSync must be able to observe a failing command; only a transport /
  // capability failure is an errno.
  const { token } = execToken({ stdout: '', stderr: 'boom', exitCode: 3 });
  const r = await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'false' });
  expect(r.ok).toBe(true);
  if (r.ok && r.kind === 'json') expect((r.json as { exitCode: number }).exitCode).toBe(3);
});

test('argv form splits argv[0] from the shell-free tail', async () => {
  const { token, calls } = execToken({ stdout: '', stderr: '', exitCode: 0 });
  await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: ['ls', '-la', '/tmp'],
  });
  expect(calls[0]?.cmd).toBe('ls');
  expect(calls[0]?.opts.args).toEqual(['-la', '/tmp']);
});

test('stdin rides through to ctx.exec', async () => {
  const { token, calls } = execToken({ stdout: '', stderr: '', exitCode: 0 });
  await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'cat', stdin: 'piped' });
  expect(calls[0]?.opts.stdin).toBe('piped');
});

function dirFs(dirs: string[], files: string[] = []): CommandContext['fs'] {
  const dirSet = new Set(dirs);
  const fileSet = new Set(files);
  return {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    stat: async (p: string) => {
      if (dirSet.has(p)) {
        return {
          isDirectory: true,
          isFile: false,
          isSymbolicLink: false,
          mode: 0o755,
          size: 0,
          mtime: new Date(),
        };
      }
      if (fileSet.has(p)) {
        return {
          isDirectory: false,
          isFile: true,
          isSymbolicLink: false,
          mode: 0o644,
          size: 1,
          mtime: new Date(),
        };
      }
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    },
  } as CommandContext['fs'];
}

test('a caller cwd override reaches ctx.exec instead of the token cwd', async () => {
  const calls: ExecCall[] = [];
  const exec = (async (cmd: string, opts: Record<string, unknown>) => {
    calls.push({ cmd, opts });
    return { stdout: `${opts.cwd}\n`, stderr: '', exitCode: 0 };
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({
    fs: dirFs(['/workspace', '/shared']),
    exec,
    cwd: '/workspace',
  });
  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: ['pwd'],
    cwd: '/shared',
  });
  expect(r.ok).toBe(true);
  expect(calls[0]?.opts.cwd).toBe('/shared');
});

test('a caller env replaces the child environment', async () => {
  const calls: ExecCall[] = [];
  const exec = (async (cmd: string, opts: Record<string, unknown>) => {
    calls.push({ cmd, opts });
    return { stdout: '', stderr: '', exitCode: 0 };
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: dirFs(['/workspace']), exec, cwd: '/workspace' });
  await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: ['printenv', 'MARKER'],
    env: { MARKER: 'x' },
  });
  expect(calls[0]?.opts.env).toEqual({ MARKER: 'x' });
  expect(calls[0]?.opts.replaceEnv).toBe(true);
});

test('a missing cwd fails closed with ENOENT and never reaches exec', async () => {
  const calls: ExecCall[] = [];
  const exec = (async (cmd: string, opts: Record<string, unknown>) => {
    calls.push({ cmd, opts });
    return { stdout: '', stderr: '', exitCode: 0 };
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: dirFs(['/workspace']), exec, cwd: '/workspace' });
  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: ['pwd'],
    cwd: '/no/such/dir',
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('ENOENT');
  expect(calls).toHaveLength(0);
});

test('a file cwd fails closed with ENOTDIR', async () => {
  const calls: ExecCall[] = [];
  const exec = (async (cmd: string, opts: Record<string, unknown>) => {
    calls.push({ cmd, opts });
    return { stdout: '', stderr: '', exitCode: 0 };
  }) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({
    fs: dirFs(['/workspace'], ['/workspace/file.txt']),
    exec,
    cwd: '/workspace',
  });
  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: ['pwd'],
    cwd: '/workspace/file.txt',
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('ENOTDIR');
  expect(calls).toHaveLength(0);
});

test('a malformed env fails closed with EINVAL before reaching exec', async () => {
  const { token, calls } = execToken({ stdout: '', stderr: '', exitCode: 0 });
  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: 'pwd',
    env: 'nope' as unknown as Record<string, string>,
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EINVAL');
  expect(calls).toHaveLength(0);
});

test('resolveSyncExecCwd inherits the base cwd when omitted', async () => {
  const r = await resolveSyncExecCwd(dirFs(['/workspace']), '/workspace', undefined);
  expect(r).toEqual({ cwd: '/workspace' });
});

test('normalizeSyncExecEnv drops undefined values and rejects non-objects', () => {
  expect(normalizeSyncExecEnv(undefined)).toBeUndefined();
  expect(normalizeSyncExecEnv({ A: '1', B: undefined, errno: 'not-an-error' })).toEqual({
    ok: true,
    env: { A: '1', errno: 'not-an-error' },
  });
  expect(normalizeSyncExecEnv('x')).toMatchObject({ errno: 'EINVAL' });
});

test('ESCALATION GUARD: an unknown / revoked token fails closed with EACCES', async () => {
  const r = await dispatchSyncExec({
    token: 'forged',
    channel: SYNC_EXEC_CHANNEL,
    command: 'whoami',
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EACCES');
});

test('a token minted without an exec handle fails closed with ENOSYS', async () => {
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], cwd: '/workspace' });
  const r = await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'ls' });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('ENOSYS');
});

test.each([
  ['empty string', ''],
  ['empty argv', []],
  ['non-string argv member', [1]],
  ['wrong type', 42],
])('a malformed command (%s) fails closed with EINVAL before reaching exec', async (_l, cmd) => {
  const { token, calls } = execToken({ stdout: '', stderr: '', exitCode: 0 });
  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: cmd as string | string[],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EINVAL');
  expect(calls).toHaveLength(0);
});

test('a malformed args array fails closed with EINVAL', async () => {
  const { token } = execToken({ stdout: '', stderr: '', exitCode: 0 });
  const r = await dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: 'ls',
    args: [1] as unknown as string[],
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('EINVAL');
});

test('a throwing shell becomes an EIO result (never a rejected promise)', async () => {
  const { token } = execToken(new Error('shell exploded'));
  const r = await dispatchSyncExec({ token, channel: SYNC_EXEC_CHANNEL, command: 'boom' });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.errno).toBe('EIO');
    expect(r.message).toContain('shell exploded');
  }
});

test('the budget aborts a hung command and reports ETIMEDOUT', async () => {
  const exec = (async (_cmd: string, opts: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], exec, cwd: '/workspace' });
  vi.useFakeTimers();
  const pending = dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: 'sleep 999',
    timeoutMs: 50,
  });
  await vi.advanceTimersByTimeAsync(60);
  const r = await pending;
  vi.useRealTimers();
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errno).toBe('ETIMEDOUT');
});

test('revoking the token aborts an in-flight command (realm killed mid-execSync)', async () => {
  // A sync exec has no spawnId the realm host can track, so without the
  // registry hook a SIGKILL'd realm left its ctx.exec running — and producing
  // side effects — for the rest of its budget.
  let aborted = false;
  const exec = (async (_cmd: string, opts: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    })) as unknown as CommandContext['exec'];
  const token = mintSyncFsToken({ fs: {} as CommandContext['fs'], exec, cwd: '/workspace' });
  const pending = dispatchSyncExec({
    token,
    channel: SYNC_EXEC_CHANNEL,
    command: 'sleep 999',
    timeoutMs: 600_000,
  });
  await Promise.resolve(); // let the dispatch reach ctx.exec
  revokeSyncFsToken(token);
  const r = await pending;
  expect(aborted).toBe(true);
  expect(r.ok).toBe(false);
  // Not ETIMEDOUT — the budget never elapsed.
  if (!r.ok) expect(r.errno).toBe('ECANCELED');
});

test('clampSyncExecTimeout bounds the caller budget and falls back on garbage', () => {
  expect(clampSyncExecTimeout(1_000, 5_000)).toBe(1_000);
  expect(clampSyncExecTimeout(undefined, 5_000)).toBe(5_000);
  expect(clampSyncExecTimeout(-1, 5_000)).toBe(5_000);
  expect(clampSyncExecTimeout(Number.NaN, 5_000)).toBe(5_000);
  expect(clampSyncExecTimeout(1e12, 5_000)).toBe(SYNC_EXEC_MAX_TIMEOUT_MS);
});

test('isSyncExecRequest discriminates the two channels', () => {
  expect(isSyncExecRequest({ token: 't', channel: SYNC_EXEC_CHANNEL, command: 'ls' })).toBe(true);
  expect(isSyncExecRequest({ token: 't', op: 'read', path: '/a' })).toBe(false);
});
