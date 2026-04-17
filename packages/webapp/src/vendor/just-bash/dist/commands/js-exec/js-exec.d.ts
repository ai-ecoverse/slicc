/**
 * js-exec - Execute JavaScript code via QuickJS (WASM)
 *
 * Runs JavaScript code in an isolated worker thread with access to the
 * virtual filesystem, HTTP, and sub-shell execution via SharedArrayBuffer bridge.
 *
 * This command is Node.js only (uses worker_threads).
 */
import type { Command } from "../../types.js";
export declare const jsExecCommand: Command;
export declare const nodeStubCommand: Command;
