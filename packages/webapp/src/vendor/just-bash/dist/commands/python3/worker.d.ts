/**
 * Worker thread for Python execution via CPython Emscripten.
 * Creates a fresh CPython WASM instance per execution (EXIT_RUNTIME).
 *
 * Security model: CPython Emscripten has zero JS bridge code.
 * `import js` fails with `ModuleNotFoundError` — the module doesn't exist.
 * `os.system()` is patched to no-op at Emscripten level.
 * No sandbox code needed — isolation is by construction.
 *
 * Defense-in-depth activates BEFORE CPython loads to block dangerous Node.js APIs.
 */
import { type WorkerDefenseStats } from "../../security/index.js";
export interface WorkerInput {
    protocolToken: string;
    sharedBuffer: SharedArrayBuffer;
    pythonCode: string;
    cwd: string;
    env: Record<string, string>;
    args: string[];
    scriptPath?: string;
    timeoutMs?: number;
}
export interface WorkerOutput {
    success: boolean;
    error?: string;
    /** Defense-in-depth stats if enabled */
    defenseStats?: WorkerDefenseStats;
}
