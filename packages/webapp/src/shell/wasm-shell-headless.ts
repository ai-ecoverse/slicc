/**
 * `HeadlessShellLike` — the worker-safe surface of `WasmShell`.
 *
 * Phase 2b step 1. The full physical split of `wasm-shell.ts` (into
 * a `WasmShellHeadless` base class + view-only `WasmShell` subclass)
 * is a follow-up; today this file declares the contract that both
 * sides will agree on. `WasmShell` already `implements
 * HeadlessShellLike` — see `wasm-shell.ts`.
 *
 * The methods below are everything the kernel worker uses from the
 * shell: command exec, env/cwd state, jsh discovery + sync, agent
 * supplemental commands. Notably absent: anything xterm/DOM-related
 * (mount, refit, line editor, history, media-preview rendering) —
 * those move to `terminal-view.ts` (Phase 2b step 3+) so the worker
 * doesn't pull xterm into its bundle and the panel-side terminal can
 * drive a *worker-resident* shell over the kernel transport.
 *
 * `HeadlessShellOptions` is the worker-safe slice of
 * `WasmShellOptions`. The `container` field stays out — only the
 * view layer needs it.
 */

import type { Bash, BashExecResult } from 'just-bash';
import type { VirtualFS } from '../fs/index.js';
import type { BrowserAPI } from '../cdp/index.js';
import type { JshDiscoveryFS } from './jsh-discovery.js';
import type { BshDiscoveryFS } from './bsh-discovery.js';
import type { ScriptCatalog } from './script-catalog.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HeadlessShellOptions {
  fs: VirtualFS;
  /** Initial working directory. Default: / */
  cwd?: string;
  /** Initial environment variables. */
  env?: Record<string, string>;
  /** BrowserAPI for the `playwright-cli` / `serve` / `open` commands. */
  browserAPI?: BrowserAPI;
  /**
   * FS to use for `.jsh` discovery. Defaults to `fs`. Useful for
   * scoops where skill loading needs the unrestricted VFS but the
   * shell uses a `RestrictedFS`.
   */
  jshDiscoveryFs?: JshDiscoveryFS;
  /** FS to use for `.bsh` discovery. Defaults to `fs`. */
  bshDiscoveryFs?: BshDiscoveryFS;
  /** Optional shared script catalog. When omitted, the shell creates one. */
  scriptCatalog?: ScriptCatalog;
  /**
   * Optional command allow-list. When omitted (or when the list
   * contains `'*'`), every built-in, custom, and `.jsh` command is
   * available. Otherwise only command heads whose names appear in
   * the list are registered on the underlying Bash instance.
   */
  allowedCommands?: readonly string[];
  /**
   * Returns the JID of the scoop whose shell this is, when running
   * inside a scoop context. Used by the `agent` supplemental
   * command to attribute spawns to the parent scoop. `undefined`
   * for terminal-panel shells with no scoop owner.
   */
  getParentJid?: () => string | undefined;
  /**
   * Returns true when this shell is owned by a non-interactive
   * scoop. Used by commands like `mount` that need a human at the
   * keyboard to approve a picker — in scoop context they should
   * fail fast instead of hanging on a tool UI nobody will see.
   */
  isScoop?: () => boolean;
}

// ---------------------------------------------------------------------------
// Headless surface
// ---------------------------------------------------------------------------

/**
 * The shell methods the kernel worker (and any future
 * terminal-view-driven RPC client) needs. `WasmShell` satisfies
 * this; future Phase 2b work pulls the implementation out into a
 * standalone `WasmShellHeadless` class.
 */
export interface HeadlessShellLike {
  /** The underlying `Bash` instance — used by tests and tools. */
  getBash(): Bash;

  /** Current working directory (mutates with `cd`). */
  getCwd(): string;

  /** Discovered `.jsh` / `.bsh` catalog. */
  getScriptCatalog(): ScriptCatalog;

  /** Latest environment variables (after the most recent `exec`). */
  getEnv(): Record<string, string>;

  /** Names of registered `.jsh` commands. */
  getJshCommandNames(): Promise<string[]>;

  /** Re-scan `.jsh` files and (re)register matching commands. Idempotent. */
  syncJshCommands(): Promise<void>;

  /**
   * One-shot non-streaming command execution. Returns the captured
   * stdout/stderr and the exit code.
   *
   * Phase 3 will thread the `Process` (with `pid`, `gate`, `abort`)
   * through here as `signal` is folded into the broader process model.
   */
  executeCommand(
    command: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /**
   * Execute a `.jsh` / `.bsh` script file by VFS path. Same return
   * shape as `executeCommand`.
   */
  executeScriptFile(
    scriptPath: string,
    args?: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// ---------------------------------------------------------------------------
// Internal helper exported from the existing `wasm-shell.ts` so the
// raw `BashExecResult` is available to callers that want stdin/stdout
// + env mutation visibility (the streaming terminal will use this in
// Phase 2b step 3+).
// ---------------------------------------------------------------------------

export type { BashExecResult };
