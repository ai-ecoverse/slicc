import type { CommandContext, IFileSystem } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { createInProcessJsRealmFactory } from '../../../src/kernel/realm/realm-inprocess.js';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import { compileWasmFromVfs, compileWasmModule } from '../../../src/kernel/realm/wasm-compiler.js';
import { executeJsCode } from '../../../src/shell/jsh-executor.js';

const ADD_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

interface PortPair {
  realm: RealmPortLike;
  host: RealmPortLike;
}

function makePortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_type, handler) => {
      realmListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      realmListeners.delete(handler);
    },
  };
  const host: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_type, handler) => {
      hostListeners.add(handler);
    },
    removeEventListener: (_type, handler) => {
      hostListeners.delete(handler);
    },
  };
  return { realm, host };
}

function makeWasmFs(path: string, bytes: Uint8Array): IFileSystem {
  return {
    async readFileBuffer(p: string) {
      if (p !== path) throw new Error(`ENOENT: ${p}`);
      return bytes;
    },
    resolvePath(base: string, p: string): string {
      if (p.startsWith('/')) return p;
      return base === '/' ? `/${p}` : `${base}/${p}`;
    },
  } as unknown as IFileSystem;
}

function makeCtx(fs: IFileSystem): CommandContext {
  return { fs, cwd: '/workspace', env: new Map(), stdin: '' } as unknown as CommandContext;
}

async function instantiateAdd(
  module: WebAssembly.Module
): Promise<(a: number, b: number) => number> {
  const instance = await WebAssembly.instantiate(module, {});
  return instance.exports.add as (a: number, b: number) => number;
}

describe('realm RPC: wasm channel', () => {
  it('compile op returns a usable WebAssembly.Module over the realm-host RPC', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/add.wasm', ADD_WASM));
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);

    const module = await client.call<WebAssembly.Module>('wasm', 'compile', ['add.wasm']);
    expect(module).toBeInstanceOf(WebAssembly.Module);

    const exports = WebAssembly.Module.exports(module);
    expect(exports.map((e) => e.name)).toContain('add');
    const add = await instantiateAdd(module);
    expect(add(2, 3)).toBe(5);

    client.dispose();
  });

  it('resolves a relative path against ctx.cwd before reading', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/pkg/add.wasm', ADD_WASM));
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    const module = await client.call<WebAssembly.Module>('wasm', 'compile', ['pkg/add.wasm']);
    expect(module).toBeInstanceOf(WebAssembly.Module);
    client.dispose();
  });

  it('rejects unknown wasm ops with a clear error', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/add.wasm', ADD_WASM));
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await expect(client.call('wasm', 'bogus', ['add.wasm'])).rejects.toThrow(/unknown wasm op/);
    client.dispose();
  });

  it('rejects a non-string path argument with a clear error', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/add.wasm', ADD_WASM));
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await expect(client.call('wasm', 'compile', [42])).rejects.toThrow(/requires a path argument/);
    client.dispose();
  });

  it('surfaces a missing-file read error to the realm caller', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/add.wasm', ADD_WASM));
    const { realm, host } = makePortPair();
    attachRealmHost(host, ctx);
    const client = new RealmRpcClient(realm);
    await expect(client.call('wasm', 'compile', ['missing.wasm'])).rejects.toThrow(/ENOENT/);
    client.dispose();
  });
});

describe('wasm-compiler helpers', () => {
  it('compileWasmModule compiles raw bytes into a Module', async () => {
    const module = await compileWasmModule(ADD_WASM);
    expect(module).toBeInstanceOf(WebAssembly.Module);
    const add = await instantiateAdd(module);
    expect(add(40, 2)).toBe(42);
  });

  it('compileWasmModule honors a subarray view (byteOffset / byteLength)', async () => {
    const padded = new Uint8Array(ADD_WASM.length + 8);
    padded.set(ADD_WASM, 4);
    const view = padded.subarray(4, 4 + ADD_WASM.length);
    const module = await compileWasmModule(view);
    expect(module).toBeInstanceOf(WebAssembly.Module);
  });

  it('compileWasmFromVfs reads via the injected reader then compiles', async () => {
    const module = await compileWasmFromVfs(async (p) => {
      expect(p).toBe('/workspace/add.wasm');
      return ADD_WASM;
    }, '/workspace/add.wasm');
    const add = await instantiateAdd(module);
    expect(add(7, 8)).toBe(15);
  });
});

describe('realm bridge: globalThis.__slicc_compileWasm', () => {
  it('realm user code compiles a VFS module host-side and instantiates it', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/add.wasm', ADD_WASM));
    const code = [
      "const mod = await globalThis.__slicc_compileWasm('/workspace/add.wasm');",
      "console.log('isModule=' + (mod instanceof WebAssembly.Module));",
      'const inst = await WebAssembly.instantiate(mod, {});',
      "console.log('sum=' + inst.exports.add(2, 3));",
    ].join('\n');
    const result = await executeJsCode(code, ['node'], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('isModule=true');
    expect(result.stdout).toContain('sum=5');
  });

  it('is removed from globalThis after the realm run completes', async () => {
    const ctx = makeCtx(makeWasmFs('/workspace/add.wasm', ADD_WASM));
    await executeJsCode("console.log('done');", ['node'], ctx, undefined, {
      realmFactory: createInProcessJsRealmFactory(),
    });
    expect((globalThis as Record<string, unknown>).__slicc_compileWasm).toBeUndefined();
  });
});
