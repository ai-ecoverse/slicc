/**
 * python3 - Execute Python code via CPython Emscripten (Python in WebAssembly)
 *
 * Runs Python code in an isolated worker thread with access to the
 * virtual filesystem via SharedArrayBuffer bridge.
 *
 * Security: CPython Emscripten has zero JS bridge code. `import js` fails
 * with ModuleNotFoundError. No sandbox needed — isolation by construction.
 *
 * This command is Node.js only (uses worker_threads).
 */
import type { Command } from "../../types.js";
/** @internal Reset queue state — for tests only */
export declare function _resetExecutionQueue(): void;
export declare const python3Command: Command;
export declare const pythonCommand: Command;
