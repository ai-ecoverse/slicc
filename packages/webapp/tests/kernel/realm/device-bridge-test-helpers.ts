/**
 * Shared fixtures for the realm device-bridge tests (usb / serial /
 * hid). A `MessagePort`-shaped pair and a noop `CommandContext` so the
 * bridge factories can round-trip through a real `RealmRpcClient` +
 * `attachRealmHost` without a worker / iframe. Mirrors the inline
 * helpers in `browser-realm.test.ts`, factored out because three
 * sibling test files need the identical scaffolding.
 */

import type { CommandContext, FsStat, IFileSystem } from 'just-bash';
import type { RealmPortLike } from '../../../src/kernel/realm/realm-rpc.js';

export interface PortPair {
  realm: RealmPortLike;
  host: RealmPortLike;
}

/** A synchronous in-memory `MessagePort` pair: posts deliver inline. */
export function makePortPair(): PortPair {
  const realmListeners = new Set<(event: MessageEvent) => void>();
  const hostListeners = new Set<(event: MessageEvent) => void>();
  const realm: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...hostListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_t, h) => {
      realmListeners.add(h);
    },
    removeEventListener: (_t, h) => {
      realmListeners.delete(h);
    },
  };
  const host: RealmPortLike = {
    postMessage: (msg) => {
      for (const h of [...realmListeners]) h({ data: msg } as MessageEvent);
    },
    addEventListener: (_t, h) => {
      hostListeners.add(h);
    },
    removeEventListener: (_t, h) => {
      hostListeners.delete(h);
    },
  };
  return { realm, host };
}

function makeNoopFs(): IFileSystem {
  const stub = async (): Promise<never> => {
    throw new Error('not implemented');
  };
  return {
    readFile: stub,
    readFileBuffer: stub,
    writeFile: stub,
    appendFile: stub,
    exists: async () => false,
    stat: stub as unknown as (p: string) => Promise<FsStat>,
    mkdir: stub,
    readdir: async () => [],
    rm: stub,
    cp: stub,
    mv: stub,
    resolvePath: (base, p) => (p.startsWith('/') ? p : `${base}/${p}`),
    getAllPaths: () => [],
    chmod: stub,
    symlink: stub,
    link: stub,
    readlink: stub,
    lstat: stub as unknown as (p: string) => Promise<FsStat>,
    realpath: async (p: string) => p,
    utimes: stub,
  } as unknown as IFileSystem;
}

/** A minimal `CommandContext` — the device channels never touch fs. */
export function makeCtx(): CommandContext {
  return {
    fs: makeNoopFs(),
    cwd: '/workspace',
    env: new Map(),
    stdin: '',
  } as CommandContext;
}
