/**
 * Worker thread for sqlite3 query execution.
 *
 * This isolates potentially long-running queries so they can be
 * terminated if they exceed the timeout.
 *
 * Uses sql.js (WASM-based SQLite) which is fully sandboxed and cannot
 * access the real filesystem.
 *
 * Security: Uses phased defense-in-depth:
 * 1. Init phase: sql.js WASM loads without restrictions
 * 2. Defense phase: Activate full blocking after sql.js init
 * 3. Execute phase: User SQL runs with all dangerous globals blocked
 */
import { type WorkerDefenseStats } from "../../security/index.js";
export interface WorkerInput {
    protocolToken: string;
    dbBuffer: Uint8Array | null;
    sql: string;
    options: {
        bail: boolean;
        echo: boolean;
    };
}
export interface WorkerSuccess {
    success: true;
    results: StatementResult[];
    hasModifications: boolean;
    dbBuffer: Uint8Array | null;
    /** Defense-in-depth stats if enabled */
    defenseStats?: WorkerDefenseStats;
}
export interface StatementResult {
    type: "data" | "error";
    columns?: string[];
    rows?: unknown[][];
    error?: string;
}
export interface WorkerError {
    success: false;
    error: string;
    /** Defense-in-depth stats if enabled */
    defenseStats?: WorkerDefenseStats;
}
export type WorkerOutput = WorkerSuccess | WorkerError;
