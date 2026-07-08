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
  /**
   * `loadPyodide({indexURL})` for `kind:'py'`. Used by the extension
   * (`chrome.runtime.getURL('pyodide/')`) and the Node test harness
   * (`file://` URL to the local `node_modules/pyodide/`). For the
   * standalone browser float (CLI / wrangler / hosted-leader cone)
   * the host passes {@link pyodideAssetRoot} instead and the worker
   * builds a synthetic blob-backed indexURL inside `runPyRealm`.
   */
  pyodideIndexURL?: string;
  /**
   * Absolute VFS path of an ipk-installed pyodide package directory
   * (e.g. `/workspace/node_modules/pyodide`). Set ONLY for the
   * standalone browser float; the realm worker reads
   * `pyodide.asm.{js,wasm}` + `python_stdlib.zip` + `pyodide-lock.json`
   * from VFS via the existing `vfs` RPC channel and feeds them to
   * `loadPyodide` through blob URLs + `lockFileContents`/`stdLibURL`
   * plus a scoped `globalThis.fetch` shim for the `pyodide.asm.wasm`
   * indexURL fetch. Bypasses the preview-SW HTTP round-trip entirely.
   * Mirrors the VFS-bytes pattern shipped by `ffmpeg-wasm.ts` and
   * `magick-wasm.ts`.
   */
  pyodideAssetRoot?: string;
  /** Initial directories synced VFS↔Pyodide-FS for `kind:'py'`. */
  pyodideMountDirs?: string[];
  /**
   * The Python realm worker resolves each `pyodideMountDirs` entry
   * against the same-origin OPFS root at `<opfsMountDbName>/<vfsPath>`
   * and mounts it via `pyodide.FS.mount(OPFS_SYNC_FS, …)`. The in-tree
   * plugin builds the FS tree synchronously from a prewalk snapshot
   * and queues OPFS mutations, which are drained via
   * `flushOpfsRealmMounts` / `flushPendingOpfsOps` before `realm-done`.
   * The realm worker has no `localStorage` shim, so the kernel side
   * passes the dbName through this field.
   */
  opfsMountDbName?: string;
  /**
   * VFS mount points that overlap `pyodideMountDirs`. The realm
   * overlays a throwing FS plugin (`MOUNT_BOMB_FS`) at each `path`
   * so any synchronous access from Python (stdlib `open`,
   * `os.listdir`, pandas, …) raises an OSError pointing the caller
   * at the async `slicc.fs` module. `kind` is informational only
   * (no cap, no materialization). Internal mounts (`/proc`, …) are
   * excluded by the kernel before this list is built.
   */
  mountPoints?: RealmMountPoint[];
}

/**
 * One entry of {@link RealmInitMsg.mountPoints}. `kind` mirrors
 * `MountBackend.kind` ('local' | 's3' | 'da'). Internal mounts
 * (`/proc`, …) are excluded by the kernel before this list is built.
 */
export interface RealmMountPoint {
  path: string;
  kind: 'local' | 's3' | 'da';
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

/**
 * Channels the kernel host exposes to user code.
 *
 * The `exec` channel carries four ops (all one-shot buffered, mirroring
 * just-bash `ctx.exec`):
 *   - `run [command]` — shell command, buffered result.
 *   - `spawn [argv]` — shell-free argv, buffered result.
 *   - `start [spawnId, commandOrArgv, { stdin, stdinKind, args }]` — the
 *     killable, buffered-stdin spawn. The realm allocates a monotonic
 *     `spawnId`; the host registers a PM process, threads an
 *     `AbortController` signal + buffered stdin into `ctx.exec`, and
 *     resolves with the buffered `{ stdout, stderr, exitCode }`.
 *   - `kill [spawnId, sig?]` — abort the in-flight `start` for `spawnId`
 *     and fan `sig` (default SIGTERM) out to its PM process; returns a
 *     `delivered` boolean (POSIX `kill(2)` semantics).
 */
export type RealmRpcChannel =
  | 'vfs'
  | 'exec'
  | 'fetch'
  | 'browser'
  | 'usb'
  | 'serial'
  | 'hid'
  | 'module'
  | 'wasm';

/**
 * Result of the `module`/`buildGraph` RPC — the ordered, host-resolved CJS
 * module graph for a realm's `require()` specifiers. Mirrors
 * {@link import('../../shell/ipk/module-loader.js').ModuleGraph} reduced to a
 * structured-clone-safe shape (raw `source` is dropped; only `cjsSource` and
 * `kind` cross the port). `errors` carries the per-entry resolution failure
 * message (e.g. `Cannot find module 'x' (run: ipk install x)`) so the realm
 * shim can throw it at `require()` time without a CDN round-trip.
 */
export interface RealmModuleGraph {
  files: { path: string; cjsSource: string; kind: string }[];
  entryMap: Record<string, string>;
  edges: Record<string, Record<string, string>>;
  errors: Record<string, string>;
  /**
   * The host-transpiled entry source — present only when the realm's entry
   * code used static/dynamic `import` or top-level `await` (the host lowers it
   * to a CJS body the realm's `AsyncFunction` wrapper can run). Absent for a
   * plain-CJS entry, in which case the realm runs `init.code` verbatim.
   */
  entrySource?: string;
}

/**
 * Tab handle returned to realm code by `browser.findTab` /
 * `browser.ensureTab`. A plain object so it round-trips through
 * structured clone without losing identity — the realm uses
 * `targetId` to address the tab on subsequent calls.
 */
export interface TabHandle {
  targetId: string;
  url: string;
  title: string;
}

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
 * Host → realm push event. Unlike `realm-rpc-res` (one per request id),
 * events are fire-and-forget: the host emits them on a named `channel`
 * and any in-realm subscriber registered via `RealmRpcClient.onEvent`
 * receives them. Used today by the HID bridge to stream `inputreport`
 * payloads to in-realm device listeners (channel `hid-input-report`,
 * payload `{ handle, reportId, bytes }`), mirroring the `panel-rpc-event`
 * page→worker fan-out one layer below.
 */
export interface RealmEventMsg {
  type: 'realm-event';
  channel: string;
  payload: unknown;
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
 * Declarative WebSocket frame selector. Skill code never supplies a
 * `Function` or a string of JS — only a JSON object whose `where` is
 * a deep-equality template the runtime matches against the parsed
 * frame body. `parseAs` chooses the parse strategy applied by the
 * page-side router before matching; `project` optionally narrows the
 * payload that crosses back to the realm/sinks.
 */
export interface WsSelector {
  /** How the page-side router parses each frame's `data` before matching. */
  parseAs?: 'json' | 'text';
  /**
   * Deep-equality template. Every key/value present in `where` must
   * match the parsed frame. Missing keys on the frame fail the match.
   */
  where?: Record<string, unknown>;
  /** Project a subset of the parsed object's top-level fields. */
  project?: readonly string[];
}

/**
 * Sanctioned forwarding destinations. Skill code cannot supply an
 * arbitrary URL — `webhook` is resolved against the existing webhook
 * registry, `scoop` against the orchestrator, `vfs` against an
 * allowlisted absolute path, `log` against telemetry.
 */
export type WsSink =
  | { sink: 'webhook'; webhookId: string }
  | { sink: 'scoop'; scoopJid: string }
  | { sink: 'vfs'; path: string }
  | { sink: 'log' };

/**
 * Args for `browser.wsObserve` (kernel-side op). The realm sends a
 * fully-resolved request; the host validates the sink, allocates a
 * subscriber id, and ensures the page-side router is installed.
 */
export interface WsObserveRequest {
  targetId: string;
  urlMatch?: string;
  filter?: WsSelector;
  forward: WsSink;
  /**
   * The scoop owning the subscriber. Used for auto-cleanup on
   * `scoop drop`; supplied by the realm bootstrap from
   * `init.env.SLICC_SCOOP_JID` when available.
   */
  scoopJid?: string;
}

/**
 * Public-facing view of an active subscriber, returned by
 * `browser.websocket.list()`.
 */
export interface WsSubscriberInfo {
  id: string;
  targetId: string;
  urlMatch?: string;
  filter?: WsSelector;
  forward: WsSink;
  scoopJid?: string;
  createdAt: string;
}

/** Outbound from the realm. */
export type RealmOutbound = RealmDoneMsg | RealmErrorMsg | RealmRpcRequest | RealmIframeReadyMsg;

/** Inbound to the realm. */
export type RealmInbound = RealmInitMsg | RealmRpcResponse | RealmPortInitMsg | RealmEventMsg;
