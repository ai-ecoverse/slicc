/**
 * `child_process` shim for the realm. `exec`/`spawn` are naturally async
 * (they call the existing `exec`/`spawn` RPC bridge — see `createExecBridge`
 * in `js-realm-shared.ts`). `execSync`/`spawnSync` are ALSO async under the
 * hood — the only way they behave synchronously from the caller's
 * perspective is that `sync-call-rewrite.ts` rewrites their call sites to
 * `await` expressions before the entry code runs inside the realm's
 * `AsyncFunction` wrapper (top-level `await` is legal there).
 *
 * `spawn()` with real streaming (ChildProcess + stdout/stderr Readable) is
 * NOT supported — the realm has no long-lived subprocess concept, only a
 * single request/response exec RPC. Callers needing streaming should use
 * `exec()`/`execSync()`/`spawnSync()` instead.
 *
 * Mirrored (functionally) in `packages/chrome-extension/sandbox.html`'s
 * `bootstrapRealmPort` for the extension float, which runs outside the TS
 * module graph.
 */

export type ExecBridge = ((cmd: string) => Promise<ExecBridgeResult>) & {
  spawn: (argv: string[]) => Promise<ExecBridgeResult>;
};

export interface ExecBridgeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecSyncOptions {
  encoding?: string | null;
  cwd?: string;
}

export interface SpawnSyncOptions {
  encoding?: string | null;
  shell?: boolean;
}

export interface SpawnSyncResult {
  stdout: unknown;
  stderr: unknown;
  status: number;
  error?: Error;
}

export interface ChildProcessShim {
  exec: (cmd: string, opts?: unknown, cb?: (...args: unknown[]) => void) => unknown;
  execSync: (cmd: string, opts?: ExecSyncOptions) => Promise<unknown>;
  spawn: (cmd: string, args?: string[]) => unknown;
  spawnSync: (cmd: string, args?: string[], opts?: SpawnSyncOptions) => Promise<SpawnSyncResult>;
}

function getBuffer():
  | { from: (data: string | Uint8Array, encoding?: string) => unknown }
  | undefined {
  return (globalThis as Record<string, unknown>).Buffer as
    | { from: (data: string | Uint8Array, encoding?: string) => unknown }
    | undefined;
}

function toBuffer(s: string): unknown {
  const B = getBuffer();
  return B ? B.from(s, 'utf8') : s;
}

/**
 * Build the realm's `child_process` shim over the shared exec RPC bridge.
 * `execBridge` is the same object `createExecBridge(rpc)` returns in
 * `js-realm-shared.ts` — a callable `(cmd) => Promise<ExecResult>` with a
 * `.spawn(argv)` sibling method.
 */
export function createChildProcessShim(execBridge: ExecBridge): ChildProcessShim {
  async function execSync(cmd: string, opts?: ExecSyncOptions): Promise<unknown> {
    const result = await execBridge(cmd);
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`Command failed: ${cmd}\n${result.stderr}`), {
        status: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    const encoding = opts?.encoding;
    if (encoding === 'utf8' || encoding === 'utf-8') return result.stdout;
    // Default (no encoding, or explicit null/'buffer'): Buffer, matching Node.
    return toBuffer(result.stdout);
  }

  async function spawnSync(
    cmd: string,
    args?: string[],
    opts?: SpawnSyncOptions
  ): Promise<SpawnSyncResult> {
    const argv = args ? [cmd, ...args] : [cmd];
    const result = opts?.shell ? await execBridge(argv.join(' ')) : await execBridge.spawn(argv);
    const encoding = opts?.encoding;
    const useString = encoding === 'utf8' || encoding === 'utf-8';
    return {
      stdout: useString ? result.stdout : toBuffer(result.stdout),
      stderr: useString ? result.stderr : toBuffer(result.stderr),
      status: result.exitCode,
    };
  }

  function exec(cmd: string, opts?: unknown, cb?: (...args: unknown[]) => void): unknown {
    const callback = typeof opts === 'function' ? (opts as (...args: unknown[]) => void) : cb;
    const promise = execBridge(cmd).then(
      (r) => {
        callback?.(null, r.stdout, r.stderr);
        return r;
      },
      (err) => {
        callback?.(err);
        throw err;
      }
    );
    return callback ? undefined : promise;
  }

  function spawn(_cmd: string, _args?: string[]): unknown {
    throw new Error(
      'child_process.spawn() with streaming is not supported in the realm. Use exec() or spawnSync() instead.'
    );
  }

  return { exec, execSync, spawn, spawnSync };
}
