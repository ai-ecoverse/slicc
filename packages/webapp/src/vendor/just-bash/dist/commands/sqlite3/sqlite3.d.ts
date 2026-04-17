/**
 * sqlite3 - SQLite database CLI
 *
 * Wraps sql.js (WASM) to provide SQLite database access through the virtual filesystem.
 * Databases are loaded from buffers and written back after modifications.
 *
 * Queries run in a worker thread with a timeout to prevent runaway queries
 * (e.g., infinite recursive CTEs) from blocking execution.
 *
 * Security: sql.js is fully sandboxed - it cannot access the real filesystem,
 * making ATTACH DATABASE and VACUUM INTO safe (they only operate on virtual buffers).
 */
import { Worker } from "node:worker_threads";
import type { Command } from "../../types.js";
import type { WorkerInput } from "./worker.js";
/** @internal Exposed for testing only */
export declare const _internals: {
    createWorker(workerPath: string, input: WorkerInput): Worker;
};
export declare const sqlite3Command: Command;
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";
export declare const flagsForFuzzing: CommandFuzzInfo;
