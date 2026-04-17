/**
 * Worker thread for JavaScript execution via QuickJS.
 * Keeps QuickJS loaded and handles multiple execution requests.
 *
 * Defense-in-depth activates AFTER QuickJS loads (WASM init needs unrestricted JS).
 * User JavaScript code runs inside the QuickJS sandbox with no access to Node.js globals.
 *
 * Build: Bundled to worker.js via esbuild (see package.json "build:worker").
 * Run: npx esbuild src/commands/js-exec/worker.ts --bundle --platform=node --format=esm --outfile=src/commands/js-exec/worker.js --external:quickjs-emscripten
 */
import { type WorkerDefenseStats } from "../../security/index.js";
export interface JsExecWorkerInput {
    protocolToken: string;
    sharedBuffer: SharedArrayBuffer;
    jsCode: string;
    cwd: string;
    env: Record<string, string>;
    args: string[];
    scriptPath?: string;
    bootstrapCode?: string;
    isModule?: boolean;
    stripTypes?: boolean;
    timeoutMs?: number;
}
export interface JsExecWorkerOutput {
    protocolToken?: string;
    success: boolean;
    error?: string;
    defenseStats?: WorkerDefenseStats;
}
