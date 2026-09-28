/**
 * GNU bash's `secret` function (`SECRET_FUNCTION`, exported to bash as
 * `BASH_FUNC_secret%%`): real GNU bash in the wasm realm imports it from its
 * environment, and a `secret set` makes `$NAME` the masked value in that same
 * running bash (a `secret delete` drops it), not only in slicc's shell. Its
 * `secret` children run the real `secret` command over an in-memory backend.
 *
 * GNU bash (the `@ai-ecoverse/wasm-bash` glue) is not a fixture: point
 * SLICC_WASM_BASH at its `bin/bash` to run this.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildSpawner } from '../../../src/kernel/wasm-realm/children.js';
import { FdTable, nullFile, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { type SpawnWasmOptions, spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import type { SecretBackend } from '../../../src/shell/supplemental-commands/secret-backends.js';
import { createSecretCommand } from '../../../src/shell/supplemental-commands/secret-command.js';
import {
  SECRET_FUNCTION,
  SECRET_FUNCTION_ENV,
} from '../../../src/shell/supplemental-commands/wasm/run.js';
import { mockCommandContext } from '../../shell/helpers/mock-command-context.js';
import { bundleProcessWorker, loadProgram, nodeWorker } from './helpers/node-wasm-process.js';

const BASH = process.env.SLICC_WASM_BASH;

let worker: { file: string; dispose(): void };
let bash: WasmProgram;

beforeAll(async () => {
  if (!BASH) return;
  worker = await bundleProcessWorker();
  bash = await loadProgram(BASH);
}, 60_000);

afterAll(() => worker?.dispose());

/** A session store: what `secret set` keeps, masked as `mask-<name>`. */
function memoryBackend(): SecretBackend {
  const values = new Map<string, string>();
  return {
    list: async () => ({ entries: [], warnings: [] }),
    getInfo: async (name: string) =>
      values.has(name) ? { name, domains: ['a.com'], persisted: false } : null,
    getMasked: async (name: string) =>
      values.has(name) ? { name, maskedValue: `mask-${name}`, domains: ['a.com'] } : null,
    peek: async () => null,
    setSession: async (name: string, value: string) => {
      values.set(name, value);
    },
    setPersisted: async () => undefined,
    setScope: async () => undefined,
    delete: async (name: string) => ({ removed: values.delete(name), fromSession: true }),
  } as unknown as SecretBackend;
}

/** `/usr/bin/bash` and `/usr/bin/secret` exist and are executable; nothing else does. */
const TREE: Record<string, string[]> = {
  '/': ['usr'],
  '/usr': ['bin'],
  '/usr/bin': ['bash', 'secret'],
};
async function stat(path: string) {
  const dir = ['/', '/usr', '/usr/bin'].includes(path);
  if (!dir && !TREE['/usr/bin'].some((n) => path === `/usr/bin/${n}`)) {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }
  return {
    isFile: !dir,
    isDirectory: dir,
    isSymbolicLink: false,
    size: 0,
    mode: dir ? 0o40755 : 0o100755,
    mtime: new Date(0),
  };
}
const fs = {
  resolvePath: (cwd: string, path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`),
  exists: async (path: string) =>
    path in TREE || TREE['/usr/bin'].some((n) => path === `/usr/bin/${n}`),
  stat,
  lstat: stat,
  readdir: async (path: string) => TREE[path] ?? [],
} as unknown as SpawnWasmOptions['fs'];

let nextPid = 9100;

/** Run `bash -c script` with `env`; its `secret` children run the real command. */
async function runBash(script: string, env: Record<string, string>): Promise<string> {
  const backend = memoryBackend();
  const secret = createSecretCommand({ isExtension: false, grants: new Set(), backend });
  const out: string[] = [];
  const err: string[] = [];
  const decoder = new TextDecoder();
  const fds = new FdTable();
  fds.installAt(0, nullFile());
  fds.installAt(
    1,
    sinkFile((b) => out.push(decoder.decode(b)))
  );
  fds.installAt(
    2,
    sinkFile((b) => err.push(decoder.decode(b)))
  );
  const net = new LoopbackNet();
  const start = (args: string[], table: FdTable, childEnv: Record<string, string>) =>
    spawnWasmProcess({
      pid: nextPid++,
      program: bash,
      argv0: 'bash',
      args,
      env: childEnv,
      cwd: '/',
      fds: table,
      fs,
      net,
      createWorker: () => nodeWorker(worker.file),
      onError: (m) => err.push(m),
      spawner,
    });
  const spawner: ChildSpawner = async (req, table) => {
    if (req.file.endsWith('bash')) {
      const child = start(req.argv.slice(1), table, req.env);
      return { pid: child.pid, exited: child.exited, termsig: child.termsig };
    }
    const pid = nextPid++;
    const exited = (async () => {
      const r = await secret.execute(req.argv.slice(1), mockCommandContext({}));
      await table.get(1).file.write?.(new TextEncoder().encode(r.stdout));
      await table.get(2).file.write?.(new TextEncoder().encode(r.stderr));
      await table.closeAll();
      return r.exitCode;
    })();
    return { pid, exited };
  };
  const handle = start(['-c', script], fds, { PATH: '/usr/bin', ...env });
  const code = await handle.exited;
  expect(err.join('')).toBe('');
  expect(code).toBe(0);
  return out.join('');
}

describe.skipIf(!BASH)('GNU bash’s secret function (real bash)', () => {
  it('exports the masked value into the running shell after a set, and drops it after a delete', async () => {
    const out = await runBash(
      [
        'secret set T_TOKEN real-value --domain a.com >/dev/null',
        'echo "after set: [$T_TOKEN] $(type -t secret)"',
        'bash -c \'echo "nested: [$T_TOKEN]"\'',
        'secret delete T_TOKEN >/dev/null',
        'echo "after delete: [${T_TOKEN-unset}]"',
        'secret set bad-name v --domain a.com >/dev/null; echo "status $?"',
      ].join('\n'),
      { [SECRET_FUNCTION_ENV]: SECRET_FUNCTION }
    );
    expect(out).toBe(
      [
        'after set: [mask-T_TOKEN] function',
        'nested: [mask-T_TOKEN]',
        'after delete: [unset]',
        'status 0',
        '',
      ].join('\n')
    );
  }, 60_000);

  it('passes a failure through and changes nothing', async () => {
    const out = await runBash(
      'secret set T_TOKEN v >/dev/null 2>&1; echo "status $? [${T_TOKEN-unset}]"',
      { [SECRET_FUNCTION_ENV]: SECRET_FUNCTION }
    );
    expect(out).toBe('status 1 [unset]\n');
  }, 60_000);

  it('without the function, the running shell never sees the value (the bug)', async () => {
    const out = await runBash(
      'secret set T_TOKEN real-value --domain a.com >/dev/null; echo "[${T_TOKEN-unset}]"',
      {}
    );
    expect(out).toBe('[unset]\n');
  }, 60_000);
});
