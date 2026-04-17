/**
 * Bash - Bash Shell Environment
 *
 * A complete bash-like shell environment using a proper AST-based architecture:
 *   Input → Parser → AST → Interpreter → Output
 *
 * This class provides the shell environment (filesystem, commands, variables)
 * and delegates execution to the Interpreter.
 */
import "./timers.js";
import { type CommandName } from "./commands/registry.js";
import { type CustomCommand } from "./custom-commands.js";
import type { IFileSystem, InitialFiles } from "./fs/interface.js";
import { type ExecutionLimits } from "./limits.js";
import { type NetworkConfig, type SecureFetch } from "./network/index.js";
import type { DefenseInDepthConfig } from "./security/types.js";
import type { BashTransformResult, TransformPlugin } from "./transform/types.js";
import type { BashExecResult, Command, FeatureCoverageWriter, TraceCallback } from "./types.js";
export type { ExecutionLimits } from "./limits.js";
/**
 * Logger interface for Bash execution logging.
 * Implement this interface to receive execution logs.
 */
export interface BashLogger {
    /** Log informational messages (exec commands, stderr, exit codes) */
    info(message: string, data?: Record<string, unknown>): void;
    /** Log debug messages (stdout output) */
    debug(message: string, data?: Record<string, unknown>): void;
}
export interface JavaScriptConfig {
    /** Bootstrap JavaScript code to run before user scripts */
    bootstrap?: string;
}
export interface BashOptions {
    files?: InitialFiles;
    env?: Record<string, string>;
    cwd?: string;
    fs?: IFileSystem;
    /**
     * Execution limits to prevent runaway compute.
     * See ExecutionLimits interface for available options.
     */
    executionLimits?: ExecutionLimits;
    /**
     * @deprecated Use executionLimits.maxCallDepth instead
     */
    maxCallDepth?: number;
    /**
     * @deprecated Use executionLimits.maxCommandCount instead
     */
    maxCommandCount?: number;
    /**
     * @deprecated Use executionLimits.maxLoopIterations instead
     */
    maxLoopIterations?: number;
    /**
     * Custom secure fetch function. When provided, used instead of creating one
     * from NetworkConfig. Enables wrapping the fetch layer with custom logic
     * (e.g., policy evaluation) while keeping built-in curl unmodified.
     * Network commands (curl, wget) are registered when either `fetch` or `network` is provided.
     */
    fetch?: SecureFetch;
    /**
     * Network configuration for commands like curl.
     * Network access is disabled by default - you must explicitly configure allowed URLs.
     */
    network?: NetworkConfig;
    /**
     * Enable python3/python commands.
     * Python is disabled by default as it introduces additional security surface
     * (arbitrary code execution via CPython Emscripten).
     */
    python?: boolean;
    /**
     * Enable js-exec command for sandboxed JavaScript execution via QuickJS.
     * Disabled by default. Can be a boolean or a config object with bootstrap code.
     */
    javascript?: boolean | JavaScriptConfig;
    /**
     * Optional list of command names to register.
     * If not provided, all built-in commands are available.
     * Use this to restrict which commands can be executed.
     */
    commands?: CommandName[];
    /**
     * Optional sleep function for the sleep command.
     * If provided, used instead of real setTimeout.
     * Useful for testing with mock clocks.
     */
    sleep?: (ms: number) => Promise<void>;
    /**
     * Custom commands to register alongside built-in commands.
     * These take precedence over built-ins with the same name.
     *
     * @example
     * ```ts
     * import { defineCommand } from "just-bash";
     *
     * const hello = defineCommand("hello", async (args) => ({
     *   stdout: `Hello, ${args[0] || "world"}!\n`,
     *   stderr: "",
     *   exitCode: 0,
     * }));
     *
     * const bash = new Bash({ customCommands: [hello] });
     * ```
     */
    customCommands?: CustomCommand[];
    /**
     * Optional logger for execution tracing.
     * When provided, logs exec commands (info), stdout (debug), stderr (info), and exit codes (info).
     * Disabled by default.
     */
    logger?: BashLogger;
    /**
     * Optional trace callback for performance profiling.
     * When provided, commands emit timing events for analysis.
     * Useful for identifying performance bottlenecks.
     */
    trace?: TraceCallback;
    /**
     * Defense-in-depth configuration.
     *
     * When enabled, monkey-patches dangerous JavaScript globals (Function, eval,
     * setTimeout, process, etc.) during script execution to block potential
     * escape vectors.
     *
     * IMPORTANT: This is a SECONDARY defense layer. It should never be relied
     * upon as the primary security mechanism. The primary security comes from
     * proper sandboxing, input validation, and architectural constraints.
     *
     * @example
     * ```ts
     * // Simple enable
     * const bash = new Bash({ defenseInDepth: true });
     *
     * // With custom configuration
     * const bash = new Bash({
     *   defenseInDepth: {
     *     enabled: true,
     *     auditMode: false, // Set to true to log but not block
     *     onViolation: (v) => console.warn('Violation:', v),
     *   },
     * });
     * ```
     */
    defenseInDepth?: DefenseInDepthConfig | boolean;
    /**
     * Feature coverage writer for fuzzing instrumentation.
     * When provided, interpreter emits coverage hits for analysis.
     */
    coverage?: FeatureCoverageWriter;
    /**
     * Virtual process info for sandboxed environment.
     * Overrides the default virtual PID/UID values exposed via $$, $PPID, $UID, $EUID, $BASHPID,
     * and /proc/self/status. Real host process info is never exposed.
     */
    processInfo?: {
        pid?: number;
        ppid?: number;
        uid?: number;
        gid?: number;
    };
}
export interface ExecOptions {
    /**
     * Environment variables to set for this execution only.
     * These are merged with the current environment and restored after execution.
     */
    env?: Record<string, string>;
    /**
     * If true, start execution with an empty environment and then apply `env`.
     * If false/omitted, `env` is merged into the current environment.
     */
    replaceEnv?: boolean;
    /**
     * Working directory for this execution only.
     * Restored to original after execution.
     */
    cwd?: string;
    /**
     * If true, skip normalizing the script (trimming leading whitespace from lines).
     * Useful when running scripts where leading whitespace is significant (e.g., here-docs).
     * Default: false
     */
    rawScript?: boolean;
    /**
     * Standard input to pass to the script.
     * This will be available to commands via stdin (e.g., for `bash -c 'cat'`).
     */
    stdin?: string;
    /**
     * Abort signal for cooperative cancellation.
     * When aborted, the interpreter stops executing at the next statement boundary.
     */
    signal?: AbortSignal;
    /**
     * Additional argv entries appended to the first executed command at the interpreter level.
     * Values bypass shell parsing entirely — no escaping, splitting, or globbing.
     * Like child_process.spawnSync(cmd, args). These do not set or modify the shell's
     * positional parameters ($1, $2, "$@", etc.).
     */
    args?: string[];
}
export declare class Bash {
    readonly fs: IFileSystem;
    private commands;
    private useDefaultLayout;
    private limits;
    private secureFetch?;
    private sleepFn?;
    private traceFn?;
    private logger?;
    private defenseInDepthConfig?;
    private coverageWriter?;
    private jsBootstrapCode?;
    private transformPlugins;
    private state;
    constructor(options?: BashOptions);
    registerCommand(command: Command): void;
    private logResult;
    exec(commandLine: string, options?: ExecOptions): Promise<BashExecResult>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    getCwd(): string;
    getEnv(): Record<string, string>;
    registerTransformPlugin(plugin: TransformPlugin<any>): void;
    transform(commandLine: string): BashTransformResult;
}
