/**
 * `realm-host.ts` — kernel-side server for realm RPC. Wires the
 * realm's `realm-rpc-req` traffic into the calling
 * `CommandContext`'s `fs` / `exec` / `fetch`.
 *
 * Critical secret-injection invariant: the `fetch` channel proxies
 * through `ctx.fetch` (just-bash `SecureFetch`) when present, NOT
 * `globalThis.fetch`. CLI mode routes outbound requests through
 * `/api/fetch-proxy` so masked secret values get substituted
 * server-side; falling back to the worker / page's native `fetch`
 * sends the literal masked value upstream and breaks every secret-
 * gated API call. Pinned in `realm-rpc.test.ts`.
 */

import type { CommandContext } from 'just-bash';
import type { RealmPortLike } from './realm-rpc.js';
import type { RealmRpcRequest, RealmRpcResponse, SerializedFetchResponse } from './realm-types.js';
import { createNodeFetchAdapter } from '../../shell/supplemental-commands/node-fetch-adapter.js';

export interface RealmHostHandle {
  /** Detach the message listener. Idempotent. */
  dispose(): void;
}

/**
 * Attach an RPC server to a realm port. Returns a handle whose
 * `dispose()` removes the listener — the runner calls it when the
 * realm exits or is force-terminated so the port doesn't keep
 * answering after the realm is gone.
 */
export function attachRealmHost(port: RealmPortLike, ctx: CommandContext): RealmHostHandle {
  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: string };
    if (data?.type !== 'realm-rpc-req') return;
    const req = event.data as RealmRpcRequest;
    void respond(port, req, ctx);
  };
  port.addEventListener('message', handler);
  port.start?.();
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', handler);
    },
  };
}

async function respond(
  port: RealmPortLike,
  req: RealmRpcRequest,
  ctx: CommandContext
): Promise<void> {
  try {
    const result = await dispatch(req, ctx);
    const res: RealmRpcResponse = { type: 'realm-rpc-res', id: req.id, result };
    // Body bytes need to be transferred so we don't structured-clone
    // potentially-large response bodies on every fetch.
    const transfer = collectTransferables(result);
    port.postMessage(res, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const res: RealmRpcResponse = { type: 'realm-rpc-res', id: req.id, error: message };
    port.postMessage(res);
  }
}

async function dispatch(req: RealmRpcRequest, ctx: CommandContext): Promise<unknown> {
  switch (req.channel) {
    case 'vfs':
      return dispatchVfs(req.op, req.args, ctx);
    case 'exec':
      return dispatchExec(req.op, req.args, ctx);
    case 'fetch':
      return dispatchFetch(req.op, req.args, ctx);
    default:
      throw new Error(`realm-host: unknown channel '${req.channel}'`);
  }
}

// ---------------------------------------------------------------------------
// Channel: vfs
// ---------------------------------------------------------------------------

/**
 * One entry in a `walkTree` response — paths are absolute (already
 * resolved against `ctx.cwd`). `content` is omitted when a file's
 * size exceeds the per-call `maxFileBytes` cap, when reading fails,
 * or for directory entries.
 */
export interface WalkTreeEntry {
  path: string;
  isDir: boolean;
  size?: number;
  content?: string;
}

/** `writeBatch` payload — directories created before files. */
export interface WriteBatchPayload {
  mkdirs?: string[];
  files?: Array<{ path: string; content: string }>;
}

async function dispatchVfs(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  const path = typeof args[0] === 'string' ? (args[0] as string) : null;
  const resolved = path !== null ? ctx.fs.resolvePath(ctx.cwd, path) : null;
  switch (op) {
    case 'readFile':
      return ctx.fs.readFile(resolved!);
    case 'readFileBinary':
      return ctx.fs.readFileBuffer(resolved!);
    case 'writeFile':
      await ctx.fs.writeFile(resolved!, args[1] as string);
      return true;
    case 'writeFileBinary':
      await ctx.fs.writeFile(resolved!, args[1] as Uint8Array);
      return true;
    case 'readDir':
      return ctx.fs.readdir(resolved!);
    case 'exists':
      return ctx.fs.exists(resolved!);
    case 'stat': {
      const st = await ctx.fs.stat(resolved!);
      return { isDirectory: st.isDirectory, isFile: st.isFile, size: st.size };
    }
    case 'mkdir':
      await ctx.fs.mkdir(resolved!, { recursive: true });
      return true;
    case 'rm':
      await ctx.fs.rm(resolved!, { recursive: true });
      return true;
    case 'resolvePath':
      return ctx.fs.resolvePath(ctx.cwd, args[0] as string);
    case 'walkTree': {
      // Recursive subtree dump in a single RPC. Replaces the
      // per-file readDir/stat/readFile chatter that made
      // VFS↔Pyodide sync take minutes on large `cwd` trees.
      const opts = (args[1] as { maxFileBytes?: number } | undefined) ?? {};
      const maxBytes = typeof opts.maxFileBytes === 'number' ? opts.maxFileBytes : Infinity;
      const entries: WalkTreeEntry[] = [];
      await collectTree(ctx, resolved!, maxBytes, entries);
      return entries;
    }
    case 'writeBatch': {
      // Bulk apply of a `{mkdirs, files}` payload. Used by the
      // post-sync diff path so a python invocation that only
      // wrote one file pays a single round-trip rather than N.
      const payload = (args[0] as WriteBatchPayload | undefined) ?? {};
      for (const dir of payload.mkdirs ?? []) {
        const resolvedDir = ctx.fs.resolvePath(ctx.cwd, dir);
        try {
          await ctx.fs.mkdir(resolvedDir, { recursive: true });
        } catch {
          /* tolerate races / already-exists */
        }
      }
      for (const file of payload.files ?? []) {
        const resolvedFile = ctx.fs.resolvePath(ctx.cwd, file.path);
        try {
          await ctx.fs.writeFile(resolvedFile, file.content);
        } catch {
          /* skip individual write failures so one bad file
             doesn't fail the entire post-sync */
        }
      }
      return true;
    }
    default:
      throw new Error(`realm-host: unknown vfs op '${op}'`);
  }
}

async function collectTree(
  ctx: CommandContext,
  root: string,
  maxBytes: number,
  out: WalkTreeEntry[]
): Promise<void> {
  let names: string[];
  try {
    names = await ctx.fs.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const full = root === '/' ? `/${name}` : `${root}/${name}`;
    let st: { isDirectory: boolean; isFile: boolean; size: number };
    try {
      st = await ctx.fs.stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory) {
      out.push({ path: full, isDir: true });
      await collectTree(ctx, full, maxBytes, out);
    } else if (st.isFile) {
      const entry: WalkTreeEntry = { path: full, isDir: false, size: st.size };
      if (st.size <= maxBytes) {
        try {
          entry.content = await ctx.fs.readFile(full);
        } catch {
          /* leave content unset; realm will treat as missing */
        }
      }
      out.push(entry);
    }
  }
}

// ---------------------------------------------------------------------------
// Channel: exec
// ---------------------------------------------------------------------------

async function dispatchExec(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  if (op !== 'run') throw new Error(`realm-host: unknown exec op '${op}'`);
  if (!ctx.exec) throw new Error('exec is not available in this runtime');
  const command = args[0] as string;
  const result = await ctx.exec(command, { cwd: ctx.cwd });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

// ---------------------------------------------------------------------------
// Channel: fetch
// ---------------------------------------------------------------------------

async function dispatchFetch(
  op: string,
  args: unknown[],
  ctx: CommandContext
): Promise<SerializedFetchResponse> {
  if (op !== 'request') throw new Error(`realm-host: unknown fetch op '${op}'`);
  const [url, init] = args as [string, RequestInit | undefined];
  // Prefer ctx.fetch (SecureFetch) — keeps secret substitution and
  // domain allow-listing on the host side. Without this, kernel-
  // realm scripts would bypass the proxy and break every
  // secret-gated API.
  const fetchFn: typeof globalThis.fetch = ctx.fetch
    ? createNodeFetchAdapter(ctx.fetch)
    : globalThis.fetch.bind(globalThis);
  const response = await fetchFn(url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url: response.url,
  };
}

// ---------------------------------------------------------------------------
// Transferables
// ---------------------------------------------------------------------------

/**
 * Collect transferable buffers from a result tree. Currently only
 * walks `Uint8Array` / `ArrayBuffer` at the top level and inside
 * `SerializedFetchResponse.body` — the only places we hand back
 * binary data today.
 */
function collectTransferables(result: unknown): Transferable[] {
  if (result instanceof Uint8Array) {
    return [result.buffer as Transferable];
  }
  if (
    result &&
    typeof result === 'object' &&
    'body' in result &&
    (result as { body?: unknown }).body instanceof Uint8Array
  ) {
    return [(result as { body: Uint8Array }).body.buffer as Transferable];
  }
  return [];
}
