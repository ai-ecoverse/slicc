/**
 * Verifies the `slicc.fs` JS bridge — the surface registered as
 * `_slicc_fs_js` and wrapped by the Python module helper. Each method
 * forwards to the `RealmRpcClient` `vfs.*` verb with the right
 * arguments and converts results so the Python wrapper sees the
 * expected JS shapes.
 *
 * The full Python wrapper (read_text encoding, walk recursion, …) is
 * exercised manually in dev (real Pyodide instance) — unit tests here
 * cover the JS bridge that the wrapper calls into, since fake
 * `pyodide.FS` doesn't run real Python.
 */
import { resolve } from 'node:path';
import { loadPyodide } from 'pyodide';
import { describe, expect, it } from 'vitest';
import type { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import {
  createSliccFsBridge,
  PYTHON_SLICC_WRAPPER,
  registerSliccFsModule,
} from '../../../src/kernel/realm/slicc-fs-module.js';

interface RpcCall {
  channel: string;
  op: string;
  args: unknown[];
}

function makeFakeRpc(responses: Record<string, (args: unknown[]) => unknown>): {
  rpc: RealmRpcClient;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const rpc = {
    call: async <T>(channel: string, op: string, args: unknown[]): Promise<T> => {
      calls.push({ channel, op, args });
      const handler = responses[op];
      if (!handler) throw new Error(`unexpected op ${op}`);
      return (await handler(args)) as T;
    },
  } as unknown as RealmRpcClient;
  return { rpc, calls };
}

describe('createSliccFsBridge: maps each method to the matching vfs RPC verb', () => {
  it('listdir → vfs.readDir', async () => {
    const { rpc, calls } = makeFakeRpc({ readDir: () => ['a', 'b', 'c'] });
    const bridge = createSliccFsBridge(rpc);
    const result = await bridge.listdir('/workspace');
    expect(result).toEqual(['a', 'b', 'c']);
    expect(calls).toEqual([{ channel: 'vfs', op: 'readDir', args: ['/workspace'] }]);
  });

  it('readBytes → vfs.readFileBinary, coerces ArrayBuffer to Uint8Array', async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const { rpc, calls } = makeFakeRpc({ readFileBinary: () => buf });
    const bridge = createSliccFsBridge(rpc);
    const result = await bridge.readBytes('/x.bin');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
    expect(calls[0].op).toBe('readFileBinary');
  });

  it('writeBytes → vfs.writeFileBinary with bytes verbatim', async () => {
    const { rpc, calls } = makeFakeRpc({ writeFileBinary: () => true });
    const bridge = createSliccFsBridge(rpc);
    const payload = new Uint8Array([7, 8, 9]);
    await bridge.writeBytes('/out.bin', payload);
    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe('writeFileBinary');
    expect(calls[0].args[0]).toBe('/out.bin');
    expect(calls[0].args[1]).toBe(payload);
  });

  it('stat → vfs.stat with shape passthrough', async () => {
    const { rpc, calls } = makeFakeRpc({
      stat: () => ({ isDirectory: false, isFile: true, size: 42 }),
    });
    const bridge = createSliccFsBridge(rpc);
    const result = await bridge.stat('/file');
    expect(result).toEqual({ isDirectory: false, isFile: true, size: 42 });
    expect(calls[0].op).toBe('stat');
  });

  it('exists → vfs.exists', async () => {
    const { rpc, calls } = makeFakeRpc({ exists: () => false });
    const bridge = createSliccFsBridge(rpc);
    expect(await bridge.exists('/missing')).toBe(false);
    expect(calls[0].op).toBe('exists');
    expect(calls[0].args).toEqual(['/missing']);
  });

  it('mkdir → vfs.mkdir', async () => {
    const { rpc, calls } = makeFakeRpc({ mkdir: () => true });
    const bridge = createSliccFsBridge(rpc);
    await bridge.mkdir('/new/dir');
    expect(calls[0].op).toBe('mkdir');
    expect(calls[0].args).toEqual(['/new/dir']);
  });

  it('remove → vfs.rm', async () => {
    const { rpc, calls } = makeFakeRpc({ rm: () => true });
    const bridge = createSliccFsBridge(rpc);
    await bridge.remove('/gone');
    expect(calls[0].op).toBe('rm');
    expect(calls[0].args).toEqual(['/gone']);
  });

  it('propagates errors from the underlying RPC verb', async () => {
    const { rpc } = makeFakeRpc({
      readFileBinary: () => {
        throw new Error('ENOENT');
      },
    });
    const bridge = createSliccFsBridge(rpc);
    await expect(bridge.readBytes('/missing')).rejects.toThrow(/ENOENT/);
  });
});

describe('createSliccFsBridge: parity across mount kinds', () => {
  // The bridge is backend-agnostic — it speaks only the `vfs` RPC
  // channel. The realm host's `dispatchVfs` resolves the path
  // through `ctx.fs.*` which routes to the right `MountBackend`
  // (local FS Access / S3 / DA). These tests exercise the path-
  // shape contract that holds for every kind.
  const KINDS = ['local', 's3', 'da'] as const;
  for (const kind of KINDS) {
    it(`${kind} mount: read/write/list use the same RPC verbs`, async () => {
      const { rpc, calls } = makeFakeRpc({
        readDir: () => ['file.txt'],
        readFileBinary: () => new Uint8Array([0x41]),
        writeFileBinary: () => true,
        stat: () => ({ isDirectory: false, isFile: true, size: 1 }),
      });
      const bridge = createSliccFsBridge(rpc);
      // Pick a path that resembles each kind's typical mount root.
      const root = kind === 'local' ? '/mnt/kb' : kind === 's3' ? '/mnt/bucket' : '/mnt/da';
      await bridge.listdir(root);
      await bridge.readBytes(`${root}/file.txt`);
      await bridge.stat(`${root}/file.txt`);
      await bridge.writeBytes(`${root}/out.bin`, new Uint8Array([0x42]));
      // The verb sequence is invariant across kinds.
      expect(calls.map((c) => c.op)).toEqual([
        'readDir',
        'readFileBinary',
        'stat',
        'writeFileBinary',
      ]);
    });
  }
});

describe('PYTHON_SLICC_WRAPPER bootstrap: imports the registered module by name', () => {
  // Regression for the real-Pyodide failure: registerJsModule attaches
  // the bridge to sys.modules but NOT to the `js` module, so reading
  // it as `js._slicc_fs_js` raises AttributeError at runtime. The fake
  // Pyodide harness used elsewhere doesn't execute the wrapper against
  // a real interpreter, so this string contract guards the bootstrap.
  const REGISTERED_NAME = '_slicc_fs_js';

  it(`imports '${REGISTERED_NAME}' as a top-level module (not via js.*)`, () => {
    expect(PYTHON_SLICC_WRAPPER).toMatch(new RegExp(`import\\s+${REGISTERED_NAME}\\s+as\\s+\\w+`));
  });

  it('does not read the bridge as an attribute of the js module', () => {
    expect(PYTHON_SLICC_WRAPPER).not.toContain('_js._slicc_fs_js');
    expect(PYTHON_SLICC_WRAPPER).not.toContain('js._slicc_fs_js');
  });

  it('registerSliccFsModule registers the same name the wrapper imports', async () => {
    const registered: string[] = [];
    const ran: string[] = [];
    const fakePyodide = {
      registerJsModule(name: string, _obj: unknown): void {
        registered.push(name);
      },
      async runPythonAsync(code: string): Promise<void> {
        ran.push(code);
      },
    } as unknown as Parameters<typeof registerSliccFsModule>[0];
    const { rpc } = makeFakeRpc({});
    await registerSliccFsModule(fakePyodide, rpc);
    expect(registered).toEqual([REGISTERED_NAME]);
    expect(ran).toHaveLength(1);
    const importMatch = ran[0].match(/import\s+(\w+)\s+as\s+\w+/);
    expect(importMatch).not.toBeNull();
    expect(importMatch?.[1]).toBe(REGISTERED_NAME);
  });
});

describe('PYTHON_SLICC_WRAPPER write paths: hand a real JS Uint8Array to the bridge', () => {
  // Regression for the Codex P1 on PR #922: `slicc.fs.write_bytes` /
  // `write_text` used to pass a Python `bytes` object straight to
  // `_bridge.writeBytes`. Pyodide hands that to JS as a `PyProxy`,
  // and the realm RPC client posts the bridge args through
  // `port.postMessage`, which structured-clones — a `PyProxy` is not
  // cloneable and the call would fail with `DataCloneError` at
  // runtime. The fix converts the buffer to a real JS `Uint8Array`
  // (via `js.Uint8Array.new(payload)`) in the Python wrapper before
  // crossing the boundary. These tests boot real Pyodide (the only
  // way to actually catch the bug — fake-Pyodide harnesses never
  // execute the wrapper) and assert that what reaches the mocked
  // bridge is a structured-clone-safe typed array.
  //
  // Single boot per describe (~1.4s on a warm cache) is amortized
  // across both assertions below.
  const PYODIDE_INDEX_URL = resolve(__dirname, '../../../../../node_modules/pyodide/');

  it('write_bytes: payload reaching _bridge.writeBytes is a real JS Uint8Array', async () => {
    const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    const calls: { path: string; data: unknown }[] = [];
    const bridge = {
      writeBytes(path: string, data: unknown): Promise<void> {
        calls.push({ path, data });
        return Promise.resolve();
      },
    };
    pyodide.registerJsModule('_slicc_fs_js', bridge);
    await pyodide.runPythonAsync(PYTHON_SLICC_WRAPPER);
    await pyodide.runPythonAsync(
      `import slicc\nawait slicc.fs.write_bytes('/out.bin', b"hello world")`
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/out.bin');
    const data = calls[0].data;
    // Real Uint8Array — not a PyProxy — so postMessage's structured
    // clone would succeed. The old `_bridge.writeBytes(path, payload)`
    // (raw Python bytes) failed this assertion because Pyodide hands
    // `bytes` to JS as a `PyProxy` whose constructor name is
    // `PyBuffer` / `PyProxy`, not `Uint8Array`.
    expect(data).toBeInstanceOf(Uint8Array);
    expect((data as Uint8Array).constructor.name).toBe('Uint8Array');
    expect(Array.from(data as Uint8Array)).toEqual([
      104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100,
    ]);
    // Belt-and-suspenders: the buffer must be structured-cloneable
    // through `postMessage`. `structuredClone` is the same algorithm
    // and fails identically on a `PyProxy`.
    expect(() => structuredClone(data)).not.toThrow();
  });

  it('write_text round-trips through write_bytes as a real JS Uint8Array', async () => {
    const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
    const calls: { path: string; data: unknown }[] = [];
    const bridge = {
      writeBytes(path: string, data: unknown): Promise<void> {
        calls.push({ path, data });
        return Promise.resolve();
      },
    };
    pyodide.registerJsModule('_slicc_fs_js', bridge);
    await pyodide.runPythonAsync(PYTHON_SLICC_WRAPPER);
    await pyodide.runPythonAsync(`import slicc\nawait slicc.fs.write_text('/out.txt', 'héllo 🌍')`);

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/out.txt');
    const data = calls[0].data;
    expect(data).toBeInstanceOf(Uint8Array);
    // UTF-8 round-trip: 'héllo 🌍' encodes to the same bytes the
    // Python wrapper produces via `text.encode('utf-8')`.
    const decoded = new TextDecoder('utf-8').decode(data as Uint8Array);
    expect(decoded).toBe('héllo 🌍');
    expect(() => structuredClone(data)).not.toThrow();
  });
});
