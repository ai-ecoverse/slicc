/**
 * `realm-types.ts` — wire protocol shared between the kernel host
 * and any realm impl (DedicatedWorker for JS in standalone, sandbox
 * iframe for JS in extension, DedicatedWorker for Pyodide in both).
 *
 * The host sends exactly one `RealmInitMsg` to kick off execution.
 * The realm responds with at most one of `RealmDoneMsg` /
 * `RealmErrorMsg` and then goes silent. Between init and done, the
 * realm may issue any number of `RealmRpcRequest` messages; the host
 * answers each with a matching `RealmRpcResponse`.
 *
 * Termination is uncatchable from the realm's side — the host
 * decides via `Realm.terminate()` (worker.terminate() or
 * iframe.remove()), which is synchronous and doesn't depend on the
 * realm cooperating. SIGKILL semantics are POSIX-style: a runaway
 * `while(true){}` exits 137 without the user code observing
 * anything.
 */

/** Which realm implementation should host this run. */
export type RealmKind = 'js' | 'py';

/**
 * Sent ONCE by the host immediately after the realm wires up its
 * RPC port. The realm starts executing on receipt and replies with
 * `realm-done` (clean exit, with the script's exit code) or
 * `realm-error` (uncaught exception in the bootstrapper). User-code
 * exceptions become `realm-done` with `exitCode=1`; `realm-error`
 * is reserved for failures BEFORE user code runs (load failures,
 * Pyodide init errors, malformed init messages).
 */
export interface RealmInitMsg {
  type: 'realm-init';
  kind: RealmKind;
  /** JS source for `kind:'js'`, Python source for `kind:'py'`. */
  code: string;
  /** Exposed as `process.argv` (JS) or `sys.argv` (py). */
  argv: string[];
  /** Exposed as `process.env` (JS) or `os.environ` (py). */
  env: Record<string, string>;
  /** Working dir surfaced to the user code. */
  cwd: string;
  /** Filename surfaced to the user code (`<eval>`, `<stdin>`, or a path). */
  filename: string;
  /**
   * Optional initial stdin (string). Consumed by both realms:
   *   • Python — surfaced as `sys.stdin`.
   *   • JS — surfaced as `process.stdin.read()` / `for await ... of
   *     process.stdin`, with Node-like EOF semantics (single read drains
   *     the buffer). See `js-realm-shared.ts` for the full shim.
   * The buffer is fully read-ahead; the realms don't model streaming.
   */
  stdin?: string;
  /** `loadPyodide({indexURL})` for `kind:'py'`. */
  pyodideIndexURL?: string;
  /** Initial directories synced VFS↔Pyodide-FS for `kind:'py'`. */
  pyodideSyncDirs?: string[];
}

/** Posted by the realm after a clean exit (incl. user-code throw → exit 1). */
export interface RealmDoneMsg {
  type: 'realm-done';
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Posted by the realm when bootstrapping fails. Distinct from
 * `realm-done` with a non-zero exit code so the runner can render a
 * generic "realm error" stderr without claiming a specific exit
 * code came from the user's `process.exit(N)`.
 */
export interface RealmErrorMsg {
  type: 'realm-error';
  message: string;
}

/** Channels the kernel host exposes to user code. */
export type RealmRpcChannel = 'vfs' | 'exec' | 'fetch';

/**
 * Realm → host RPC. Each request gets exactly one matching
 * response (by `id`). The realm side is free to fire-and-forget
 * concurrently; the host serializes them as they arrive.
 */
export interface RealmRpcRequest {
  type: 'realm-rpc-req';
  id: number;
  channel: RealmRpcChannel;
  op: string;
  args: unknown[];
}

/** Host → realm reply for a previous `realm-rpc-req`. */
export interface RealmRpcResponse {
  type: 'realm-rpc-res';
  id: number;
  /** Present iff the call succeeded. */
  result?: unknown;
  /** Present iff the call threw — string-formatted host-side. */
  error?: string;
}

/**
 * Sandbox iframe handshake: posted from inside the iframe when its
 * bootstrap has loaded and is ready to receive a port. The host
 * responds with a `realm-port-init` carrying the transferred port.
 * Used only by the iframe realm; workers don't need this since
 * their port is the worker itself.
 */
export interface RealmIframeReadyMsg {
  type: 'realm-iframe-ready';
}

/** Host → iframe handshake reply: hands over the MessagePort. */
export interface RealmPortInitMsg {
  type: 'realm-port-init';
  /** Transferred via the second arg to `postMessage`. */
}

/**
 * Serialized `Response` payload for `fetch` RPC results. We can't
 * postMessage a real `Response` over a port, so the host reduces
 * the response to a transferable bag and the realm reconstructs a
 * `Response` instance from it.
 */
export interface SerializedFetchResponse {
  status: number;
  statusText: string;
  /** Header name → value, all lowercased per Headers semantics. */
  headers: Record<string, string>;
  /** Body bytes; empty `Uint8Array` for empty responses. */
  body: Uint8Array;
  /** `response.url` after redirect resolution (or '' if unknown). */
  url: string;
}

/**
 * One entry in a `vfs.walkTree` response. Paths are absolute (host
 * already resolved against `ctx.cwd`).
 *
 * Discriminated on `isDir` so directory entries can't pretend to
 * carry a `size`/`content` and file entries always carry a `size`.
 * `content` is omitted ONLY when the file exceeded the per-call
 * `maxFileBytes` cap or could not be read — see the realm-side
 * skip-with-warning path in `py-realm-shared.ts`.
 *
 * `content` is `Uint8Array`, not `string`: walkTree must round-trip
 * binary files (PNG, sqlite, .whl, …) byte-for-byte. The realm
 * transfers ownership to avoid copying.
 */
export type WalkTreeEntry =
  | { path: string; isDir: true }
  | { path: string; isDir: false; size: number; content?: Uint8Array };

/**
 * Bulk-write payload for `vfs.writeBatch`. Directories are created
 * before files; ordering across the two arrays is host-controlled.
 * `content` is `Uint8Array` for the same reason as `WalkTreeEntry`.
 */
export interface WriteBatchPayload {
  mkdirs?: readonly string[];
  files?: ReadonlyArray<{ path: string; content: Uint8Array }>;
}

/**
 * Per-entry result of a `vfs.writeBatch`. The host applies
 * everything best-effort and reports back which paths it couldn't
 * write so the realm can surface them as stderr warnings instead
 * of silently losing the user's files.
 */
export interface WriteBatchResult {
  ok: true;
  failedMkdirs: ReadonlyArray<{ path: string; error: string }>;
  failedFiles: ReadonlyArray<{ path: string; error: string }>;
}

/** Outbound from the realm. */
export type RealmOutbound = RealmDoneMsg | RealmErrorMsg | RealmRpcRequest | RealmIframeReadyMsg;

/** Inbound to the realm. */
export type RealmInbound = RealmInitMsg | RealmRpcResponse | RealmPortInitMsg;
